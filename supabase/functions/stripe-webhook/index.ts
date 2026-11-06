import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { handleStripeWebhook } from "../_shared/stripe-webhook.ts";

/**
 * Receives Stripe's events. verify_jwt is off because Stripe has no Supabase
 * session; the Stripe-Signature header, checked against the webhook secret in
 * Vault, is the authentication. See _shared/stripe-webhook.ts for the rules.
 * Without a webhook secret it refuses everything rather than guess.
 */
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(req: Request) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return reply({ error: "Server not configured" }, 500);
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    try {
      return await handleStripeWebhook({ admin }, req);
    } catch (error) {
      await logEdgeError(admin, "stripe-webhook", error);
      return reply({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
