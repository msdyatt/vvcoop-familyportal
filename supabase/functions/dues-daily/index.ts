import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { safeEqual } from "../_shared/crypto.ts";
import { runDuesDaily } from "../_shared/dues-jobs.ts";
import { logEdgeError } from "../_shared/error-log.ts";
import { readVaultSecret } from "../_shared/resend.ts";
import { json } from "../_shared/http.ts";
import { loadStripeConfig, StripeClient } from "../_shared/stripe.ts";

/**
 * The daily dues run, called by pg_cron (no session; gated by the same Vault
 * shared secret deliver-emails uses): housekeeping, installment reminders, and
 * automatic collection of each household's next due installment.
 *
 * With billing off or no Stripe key, only the housekeeping and reminders run.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const secret = await readVaultSecret(admin, "EMAIL_DELIVERY_SECRET");
  if (!secret || !safeEqual(req.headers.get("x-delivery-secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const config = await loadStripeConfig(admin);
  const today = new Date().toISOString().slice(0, 10);
  const summary = await runDuesDaily({ admin, stripe: config.ok ? new StripeClient(config.secretKey) : null }, today);
  return json({ ok: true, billing: config.ok ? config.provider : config.code, ...summary });
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
        await logEdgeError(adminClient, "dues-daily", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
