import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { safeEqual } from "../_shared/crypto.ts";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { runSync } from "../_shared/office-inbox.ts";
import { authenticateInboxAdmin, loadInboxConfig, readSavedInboxConfig } from "../_shared/office-inbox-env.ts";

/**
 * Brings new office mail into the portal.
 *
 *   { mode: "process" }  the every-minute pg_cron job. No session; it must present the
 *                        OFFICE_INBOX_CRON_SECRET from Vault (made by the migration).
 *   { mode: "now" }      "Sync now" on the Integrations card or in the inbox, by an administrator.
 *
 * A run holds a 90-second lease, so overlapping calls do nothing. Mail is never deleted or
 * marked read in Gmail; imported messages get the "Portal imported" label.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const body = await req.json().catch(() => null) as { mode?: string } | null;

  if (body?.mode === "process") {
    const { data: secret } = await admin.rpc("read_vault_secret", { secret_name: "OFFICE_INBOX_CRON_SECRET" });
    const presented = req.headers.get("x-delivery-secret") ?? "";
    if (!secret || !safeEqual(presented, secret as string)) return json({ error: "Unauthorized" }, 401);
  } else if (body?.mode === "now") {
    const auth = await authenticateInboxAdmin(req);
    if (!auth.ok) return auth.response;
  } else {
    return json({ error: "Unknown mode." }, 400);
  }

  const loaded = loadInboxConfig(undefined, await readSavedInboxConfig((fn) => admin.rpc(fn)));
  if (!loaded.ok) return json({ error: `The office inbox is not set up yet. Missing: ${loaded.missing.join(", ")}. Fill them in on the Office inbox card in Admin, Integrations.` }, 400);

  const result = await runSync({
    rpc: (fn, args) => admin.rpc(fn, args),
    upload: async (path, bytes, contentType) => {
      const { error } = await admin.storage.from("office-inbox").upload(path, bytes, { contentType, upsert: true });
      return { error: error ? { message: error.message } : null };
    },
    fetch,
    oauth: { clientId: loaded.config.clientId, clientSecret: loaded.config.clientSecret },
  });
  if (result.error && !result.attention) await logEdgeError(admin, "office-inbox-sync", new Error(result.error));
  return json(result);
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        await logEdgeError(createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }), "office-inbox-sync", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
