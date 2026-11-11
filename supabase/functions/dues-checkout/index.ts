import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { authenticate } from "../_shared/auth.ts";
import { createDuesCheckout } from "../_shared/dues-checkout.ts";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { loadStripeConfig, StripeClient } from "../_shared/stripe.ts";

/**
 * A household member asks to pay a dues charge. Returns the address of Stripe's
 * hosted page, where card, bank and wallet details are entered. The page never
 * says how much to charge; the database works that out.
 *
 *   { chargeId, payAll?, autopay?, embedded? }  ->  { kind: "embedded", clientSecret, publishableKey }
 *                                              or { kind: "hosted", url }
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  const body = await req.json().catch(() => null) as { chargeId?: string; payAll?: boolean; autopay?: boolean; embedded?: boolean; native?: boolean } | null;
  const chargeId = body?.chargeId?.trim();
  if (!chargeId) return json({ error: "Say which charge to pay." }, 400);

  const config = await loadStripeConfig(caller.admin);
  if (!config.ok) {
    // Families get a gentle line; the real reason is in config.message for administrators.
    return json({ error: caller.isAdmin ? config.message : "Online payment is not available yet. Please contact the co-op.", code: config.code }, config.code === "off" ? 409 : 503);
  }

  const result = await createDuesCheckout(
    { admin: caller.admin, stripe: new StripeClient(config.secretKey), config },
    { userId: caller.userId, userEmail: caller.email, chargeId, payAll: Boolean(body?.payAll), autopay: Boolean(body?.autopay), embedded: Boolean(body?.embedded), native: Boolean(body?.native) },
  );
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
  if (result.kind === "native") {
    return json({ kind: "native", paymentIntentClientSecret: result.paymentIntentClientSecret, publishableKey: result.publishableKey, customerId: result.customerId, merchantDisplayName: result.merchantDisplayName, amountCents: result.amountCents, paymentId: result.paymentId });
  }
  return json(result.kind === "embedded"
    ? { kind: "embedded", clientSecret: result.clientSecret, publishableKey: result.publishableKey, paymentId: result.paymentId }
    : { kind: "hosted", url: result.url, paymentId: result.paymentId });
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
        await logEdgeError(adminClient, "dues-checkout", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
