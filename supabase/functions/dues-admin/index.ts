import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { authenticate } from "../_shared/auth.ts";
import { cancelPendingPayment, describeAccount, reconcileWithStripe, refundDuesPayment, syncPendingPayments } from "../_shared/dues-admin.ts";
import { logEdgeError } from "../_shared/error-log.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { loadStripeConfig, loadWebhookSecrets, StripeClient, StripeError } from "../_shared/stripe.ts";

/**
 * Administrator actions that talk to Stripe. Everything else an administrator
 * does (adjustments, plans, cash) is a database function called directly.
 *
 *   { action: "status" }                      what is configured, and which Stripe account the key belongs to
 *   { action: "refund", paymentId, amountCents, reason, reduceOwed, approvalId? }
 *   { action: "sync" }                        ask Stripe about every pending payment (a missed webhook)
 *   { action: "reconcile" }                   compare recent settled payments with Stripe
 *   { action: "cancel", paymentId }           close a stuck, unstarted payment
 *
 * Admin-only, with two-factor step-up, because every one of these touches money.
 */
async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await authenticate(req, { adminOnly: true });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");

  const config = await loadStripeConfig(caller.admin);

  if (action === "status") {
    const secrets = await loadWebhookSecrets(caller.admin);
    const out: Record<string, unknown> = {
      provider: config.provider,
      keyConfigured: config.ok,
      // Without the publishable key the website and the apps cannot show Stripe's payment form in the page or in
      // the native sheet; families are sent to Stripe's own page in a browser instead.
      publishableKeyConfigured: config.ok ? Boolean(config.publishableKey) : null,
      problem: config.ok ? null : config.message,
      webhookSecretConfigured: config.provider === "stripe_live" ? Boolean(secrets.live) : config.provider === "stripe_test" ? Boolean(secrets.test) : Boolean(secrets.test || secrets.live),
    };
    if (config.ok) {
      try { out.account = await describeAccount(new StripeClient(config.secretKey)); }
      catch (error) { out.problem = error instanceof StripeError ? `Stripe rejected the key: ${error.message}` : "Could not reach Stripe."; out.keyConfigured = false; }
    }
    return json(out);
  }

  if (!config.ok) return json({ error: config.message, code: config.code }, config.code === "off" ? 409 : 503);
  const stripe = new StripeClient(config.secretKey);
  const deps = { admin: caller.admin, stripe };

  switch (action) {
    case "refund": {
      const result = await refundDuesPayment(deps, {
        actorId: caller.userId, paymentId: String(body?.paymentId ?? ""), amountCents: Number(body?.amountCents),
        reason: String(body?.reason ?? "").trim(), reduceOwed: body?.reduceOwed !== false,
        approvalId: body?.approvalId ? String(body.approvalId) : null,
      });
      return result.ok ? json(result) : json({ error: result.error }, result.status);
    }
    case "sync": return json(await syncPendingPayments(deps));
    case "reconcile": return json(await reconcileWithStripe(deps));
    case "cancel": {
      const result = await cancelPendingPayment(deps, String(body?.paymentId ?? ""));
      return result.ok ? json(result) : json({ error: result.error }, result.status);
    }
    default: return json({ error: "Unknown action." }, 400);
  }
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
        await logEdgeError(adminClient, "dues-admin", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
