import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";
import { deleteAccount } from "../_shared/account-deletion.ts";
import { getFromAddress, readVaultSecret, sendViaResend } from "../_shared/resend.ts";
import { escapeHtml, renderEmail } from "../_shared/email-template.ts";

/**
 * Permanently deletes an account.
 *
 *   { confirm: "DELETE", deleteHousehold?: boolean }
 *       the signed-in person deletes their own account.
 *   { confirm: "DELETE", targetUserId, deleteHousehold? }
 *       an administrator deletes someone else's account (a deletion request
 *       that came by email, or an account that was only ever "removed").
 *
 * The typed confirmation is checked here, not just in the app, and a person
 * with a second factor must have completed it for this session.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authorization = req.headers.get("Authorization");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey || !authorization) return json({ error: "Unauthorized" }, 401);

  const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);
  if (await needsMfaStepUp(userClient)) return json({ error: "Complete two-factor verification before continuing." }, 403);

  const body = await req.json().catch(() => null) as { confirm?: string; targetUserId?: string; deleteHousehold?: boolean } | null;
  if (body?.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const targetId = body.targetUserId?.trim() || user.id;
  const selfDeletion = targetId === user.id;

  if (!selfDeletion) {
    const [{ data: profile }, { data: role }] = await Promise.all([
      admin.from("profiles").select("status").eq("id", user.id).single(),
      admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
    ]);
    if (profile?.status !== "active" || !role) return json({ error: "Administrator access is required." }, 403);
  }

  const result = await deleteAccount(admin, targetId, Boolean(body.deleteHousehold));
  if (!result.ok) return result.response;

  // A confirmation to the person's own address, sent directly and not logged,
  // so no new record of that address is created by deleting it.
  if (selfDeletion && result.outcome.email) {
    try {
      const [from, apiKey] = await Promise.all([getFromAddress(admin), readVaultSecret(admin, "RESEND_API_KEY")]);
      if (from && apiKey) {
        const html = renderEmail({
          eyebrow: "Account deleted", heading: "Your Family Village account has been deleted.", preheader: "Your account was deleted.",
          bodyHtml: `<p>Your Family Village account for ${escapeHtml(result.outcome.email)} has been permanently deleted, along with your messages and personal details.</p><p>If you didn&rsquo;t do this, contact <a href="mailto:admin@veritasvillage.org">admin@veritasvillage.org</a> right away.</p>`,
        });
        await sendViaResend(apiKey, from, result.outcome.email, "Your Family Village account was deleted", html);
      }
    } catch { /* the deletion already happened; the courtesy email is best effort */ }
  }

  return json({ ok: true, householdsDeleted: result.outcome.householdsDeleted, householdsWithoutAdults: result.outcome.householdsWithoutAdults });
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
        await logEdgeError(adminClient, "delete-account", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
