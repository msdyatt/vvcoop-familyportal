import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { readVaultSecret, sendViaResend } from "../_shared/resend.ts";
import { safeEqual } from "../_shared/crypto.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";

/**
 * Sends queued email_outbox rows through Resend, and offers an admin-only
 * "send a test email" path.
 *
 * The Resend API key is never a Deno env secret here -- this project has no
 * way to run `supabase secrets set` without the site owner's own CLI login,
 * so the key instead lives in Supabase Vault (set once via a live SQL call,
 * never committed to a migration file) and is read fresh on every request
 * through this function's own service-role database access.
 *
 * Two request shapes:
 *   { mode: "process" }        -- drains the pending outbox. No user session
 *                                  (pg_cron has none); gated instead by a
 *                                  shared secret header, also Vault-stored,
 *                                  matching the fail-closed pattern already
 *                                  used by opensign-webhook.
 *   { mode: "test", to }       -- one-off send to confirm the connection,
 *                                  gated by a normal admin session like every
 *                                  other admin-invoked function in this
 *                                  project (opensign-send, opensign-sync).
 */

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const body = await req.json().catch(() => null) as { mode?: string; to?: string } | null;

  if (body?.mode === "test") {
    const authorization = req.headers.get("Authorization");
    if (!authorization) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: "Your session has expired. Please sign in again." }, 401);
    const [{ data: profile }, { data: role }] = await Promise.all([
      adminClient.from("profiles").select("status").eq("id", user.id).single(),
      adminClient.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
    ]);
    if (profile?.status !== "active" || !role) return json({ error: "Administrator access is required." }, 403);
    if (await needsMfaStepUp(userClient)) return json({ error: "Complete two-factor verification before continuing." }, 403);

    const to = body?.to?.trim();
    if (!to) return json({ error: "A destination email address is required." }, 400);

    const { data: integration } = await adminClient.from("integration_settings").select("from_address").eq("id", "resend").maybeSingle();
    const from = integration?.from_address?.trim();
    if (!from) return json({ error: "Set a From address in Admin → Integrations first." }, 400);

    const apiKey = await readVaultSecret(adminClient, "RESEND_API_KEY");
    if (!apiKey) return json({ error: "Resend is not configured. The RESEND_API_KEY secret has not been set." }, 400);

    const result = await sendViaResend(apiKey, from, to, "Veritas Village test email", "<p>This is a test email from the Veritas Village Family Portal's Resend integration. If you can read this, it's working.</p>");
    await adminClient.from("integration_settings").update({ status: result.ok ? "connected" : "attention", last_checked_at: new Date().toISOString() }).eq("id", "resend");
    if (!result.ok) return json({ ok: false, detail: result.error });
    return json({ ok: true, detail: `Test email sent to ${to}.` });
  }

  if (body?.mode === "process") {
    const secret = await readVaultSecret(adminClient, "EMAIL_DELIVERY_SECRET");
    const presented = req.headers.get("x-delivery-secret") ?? "";
    if (!secret || !safeEqual(presented, secret)) return json({ error: "Unauthorized" }, 401);

    const [{ data: integration }, apiKey, { data: pending }] = await Promise.all([
      adminClient.from("integration_settings").select("from_address").eq("id", "resend").maybeSingle(),
      readVaultSecret(adminClient, "RESEND_API_KEY"),
      adminClient.from("email_outbox").select("id,recipient_email,subject,html_body").eq("status", "pending").order("created_at").limit(100),
    ]);
    const from = integration?.from_address?.trim();
    const rows = (pending ?? []) as { id: string; recipient_email: string; subject: string; html_body: string }[];

    if (!from || !apiKey) {
      // Leave the rows pending -- they will be picked up once the site owner
      // finishes setup, rather than silently marking them failed for a
      // configuration gap that is not the email's fault.
      return json({ ok: true, sent: 0, skipped: rows.length, reason: !from ? "No From address configured." : "Resend API key not set." });
    }

    // Sent in small concurrent batches rather than one row at a time: at up to
    // 100 pending rows, a fully sequential loop pays for ~200 round trips
    // (Resend + the status update) back to back on a function that runs on a
    // fixed daily schedule, and risks the function's own execution-time limit
    // once there's any real backlog. A batch size of 10 keeps this well clear
    // of Resend's own rate limit while still cutting that to ~20 waits.
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 10;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (row) => {
        const result = await sendViaResend(apiKey, from, row.recipient_email, row.subject, row.html_body);
        if (result.ok) {
          sent += 1;
          await adminClient.from("email_outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", row.id);
        } else {
          failed += 1;
          await adminClient.from("email_outbox").update({ status: "failed", error_detail: result.error.slice(0, 500) }).eq("id", row.id);
        }
      }));
    }
    return json({ ok: true, sent, failed });
  }

  return json({ error: "Unknown mode." }, 400);
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
        await logEdgeError(adminClient, "deliver-emails", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
