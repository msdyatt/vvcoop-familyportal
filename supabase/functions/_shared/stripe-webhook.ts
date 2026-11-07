import { logEdgeError } from "./error-log.ts";
import { loadStripeConfig, loadWebhookSecrets, readProvider, StripeClient, verifyStripeSignature } from "./stripe.ts";
import { processStripeEvent, type StripeEvent } from "./stripe-events.ts";
import type { AdminClient } from "./types.ts";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The webhook's whole decision procedure, separate from the function wrapper so
 * it can be tested. This is the only thing that moves a payment to "paid".
 *
 *   - the signature is checked against the raw body before anything is parsed;
 *   - an event from the other mode is acknowledged and set aside;
 *   - each event is recorded once by Stripe's event id; a repeat is a no-op;
 *   - a failure while applying answers 500 so Stripe delivers it again.
 */
export async function handleStripeWebhook(
  deps: { admin: AdminClient; makeStripe?: (key: string) => StripeClient; nowSeconds?: number },
  req: Request,
): Promise<Response> {
  const { admin } = deps;
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const secrets = await loadWebhookSecrets(admin);
  if (!secrets.test && !secrets.live) return reply({ error: "Stripe webhook secret not configured" }, 503);

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  // Test and live endpoints have different signing secrets; the one that
  // verifies tells us which mode the event came from.
  let signedAs: "test" | "live" | null = null;
  if (secrets.test && await verifyStripeSignature(rawBody, signature, secrets.test, deps.nowSeconds)) signedAs = "test";
  else if (secrets.live && await verifyStripeSignature(rawBody, signature, secrets.live, deps.nowSeconds)) signedAs = "live";
  if (!signedAs) return reply({ error: "Invalid signature" }, 400);

  let event: StripeEvent;
  try { event = JSON.parse(rawBody) as StripeEvent; } catch { return reply({ error: "Expected a JSON body" }, 400); }
  if (!event?.id || !event.type) return reply({ error: "Not a Stripe event" }, 400);

  const provider = await readProvider(admin);
  if (signedAs !== (event.livemode ? "live" : "test") || provider !== (event.livemode ? "stripe_live" : "stripe_test")) {
    // Record that it arrived, say why it was set aside, and let Stripe stop retrying.
    const { data: claim } = await admin.rpc("stripe_claim_event", { p_id: event.id, p_type: event.type, p_livemode: event.livemode, p_payload: null });
    if (claim !== "processed") await admin.rpc("stripe_finish_event", { p_id: event.id, p_error: `Set aside: the app is in ${provider} mode.` });
    return reply({ ok: true, ignored: "mode" });
  }

  const { data: claim, error: claimError } = await admin.rpc("stripe_claim_event", {
    p_id: event.id, p_type: event.type, p_livemode: event.livemode, p_payload: event,
  });
  if (claimError) throw new Error(claimError.message);
  if (claim === "processed") return reply({ ok: true, duplicate: true });

  const config = await loadStripeConfig(admin);
  if (!config.ok) {
    await admin.rpc("stripe_finish_event", { p_id: event.id, p_error: config.message });
    return reply({ error: config.message }, 503);   // Stripe will retry once the key is in place
  }

  try {
    const stripe = (deps.makeStripe ?? ((key) => new StripeClient(key)))(config.secretKey);
    const outcome = await processStripeEvent({ admin, stripe }, event);
    await admin.rpc("stripe_finish_event", { p_id: event.id, p_error: null });
    return reply({ ok: true, outcome });
  } catch (error) {
    await admin.rpc("stripe_finish_event", { p_id: event.id, p_error: error instanceof Error ? error.message : String(error) });
    await logEdgeError(admin, "stripe-webhook", error, { eventId: event.id, type: event.type });
    return reply({ error: "Could not apply the event; Stripe will retry." }, 500);
  }
}
