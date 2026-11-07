import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { needsMfaStepUp } from "../_shared/aal.ts";
import { sealRequest, supabaseSealStore } from "../_shared/esign-seal.ts";

/**
 * Seals a fully signed request: flattens the entries onto the PDF, appends the
 * certificate page, stores the result in the private bucket and marks the
 * requirement complete.
 *
 *   { requestId }
 *
 * Called by the browser right after the last person signs, and again by an
 * administrator if that call never arrived. Who may call it is decided by the
 * database: the request has to be visible to the caller under row level
 * security, which means one of its signers, a member of the household, or an
 * administrator, and only in a session that has reached its second factor.
 * The sealing itself then runs with the service role.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  const body = await req.json().catch(() => null) as { requestId?: string } | null;
  const requestId = body?.requestId ?? "";
  if (!UUID.test(requestId)) return json({ error: "Missing request." }, 400);

  // Visible to this caller under row level security, or it does not exist as far as they are concerned.
  const { data: visible } = await userClient.from("sign_requests").select("id").eq("id", requestId).maybeSingle();
  if (!visible) return json({ error: "You cannot open that record." }, 403);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const outcome = await sealRequest(supabaseSealStore(admin), requestId);

  if (outcome.ok) return json({ ok: true, status: outcome.status, alreadySealed: outcome.alreadySealed });
  if (outcome.status === "failed") await logEdgeError(admin, "esign-seal", new Error(outcome.message), { requestId });
  const status = outcome.status === "busy" ? 202 : outcome.status === "not_ready" ? 409 : 500;
  return json({ ok: false, status: outcome.status, error: outcome.status === "failed" ? "The signed copy could not be prepared. An administrator can try again." : outcome.message }, status);
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
        await logEdgeError(adminClient, "esign-seal", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
