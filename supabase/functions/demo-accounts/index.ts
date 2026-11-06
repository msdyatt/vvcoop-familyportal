import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";
import { createOrResetDemoAccounts, removeDemoAccounts } from "../_shared/demo-accounts.ts";

/**
 * Administrator-only: create (or reset the passwords and sample data of) the
 * reviewer accounts for the App Store and Google Play, or remove them.
 *
 *   { action: "create" } -> { ok, accounts: [{ role, email, password }] }
 *   { action: "remove" } -> { ok, removed }
 *
 * The passwords are generated here, returned once, and stored nowhere.
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

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: profile }, { data: role }] = await Promise.all([
    admin.from("profiles").select("status,is_demo").eq("id", user.id).single(),
    admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle(),
  ]);
  if (profile?.status !== "active" || !role || profile?.is_demo) return json({ error: "Administrator access is required." }, 403);
  if (await needsMfaStepUp(userClient)) return json({ error: "Complete two-factor verification before continuing." }, 403);

  const body = await req.json().catch(() => null) as { action?: string } | null;
  if (body?.action === "create") {
    const result = await createOrResetDemoAccounts(admin);
    if (!result.ok) return json({ error: result.error }, 500);
    await admin.from("audit_log").insert({ actor_user_id: user.id, action: "demo_accounts_created", subject_type: "demo_accounts", subject_id: "reviewer", detail: {} });
    return json({ ok: true, accounts: result.accounts });
  }
  if (body?.action === "remove") {
    const result = await removeDemoAccounts(admin);
    if (!result.ok) return json({ error: result.error }, 500);
    await admin.from("audit_log").insert({ actor_user_id: user.id, action: "demo_accounts_removed", subject_type: "demo_accounts", subject_id: "reviewer", detail: {} });
    return json({ ok: true, removed: result.removed });
  }
  return json({ error: "Unknown action." }, 400);
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
        await logEdgeError(admin, "demo-accounts", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
