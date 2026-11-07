import { describeCharge, friendlyFailure, type StripeClient } from "./stripe.ts";
import type { AdminClient } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

/**
 * What the portal does with each thing Stripe tells it.
 *
 * The webhook is the only writer of paid totals. It never trusts an event's
 * payload for the state of a payment: it re-reads the PaymentIntent from Stripe,
 * so a stale or out-of-order event cannot move a payment the wrong way. The
 * database then refuses any backwards step on its own (see billing_apply_payment_update).
 */

export type StripeEvent = { id: string; type: string; livemode: boolean; data: { object: any } };
export type EventDeps = { admin: AdminClient; stripe: StripeClient };

async function rpc(admin: AdminClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/** The portal's own payment row for a PaymentIntent, if it is one of ours. */
async function findPayment(admin: AdminClient, paymentIntent: any): Promise<{ id: string; status: string; source: string } | null> {
  const metadataId = paymentIntent?.metadata?.payment_id;
  const query = admin.from("dues_payments").select("id,status,source");
  const { data } = metadataId
    ? await query.eq("id", metadataId).maybeSingle()
    : await query.eq("stripe_payment_intent_id", paymentIntent.id).maybeSingle();
  return data ?? null;
}

const PI_EXPANDED = { expand: ["latest_charge"] };

/** Re-reads a PaymentIntent and applies whatever state it is really in. */
export async function applyPaymentIntent(deps: EventDeps, paymentIntentId: string, eventId: string | null, options: { finalFailure?: boolean } = {}): Promise<string> {
  const pi = await deps.stripe.get(`/v1/payment_intents/${paymentIntentId}`, PI_EXPANDED);
  return applyFetchedPaymentIntent(deps, pi, eventId, options);
}

export async function applyFetchedPaymentIntent(deps: EventDeps, pi: any, eventId: string | null, options: { finalFailure?: boolean } = {}): Promise<string> {
  const payment = await findPayment(deps.admin, pi);
  if (!payment) return "not_ours";

  let charge: any = pi.latest_charge;
  if (typeof charge === "string") charge = await deps.stripe.get(`/v1/charges/${charge}`);
  const shown = describeCharge(charge);
  const base = {
    payment_intent_id: pi.id,
    payment_method_id: typeof pi.payment_method === "string" ? pi.payment_method : pi.payment_method?.id ?? null,
    mandate_id: typeof pi.mandate === "string" ? pi.mandate : null,
    ...shown,
  };

  let status: string;
  const fields: Record<string, unknown> = { ...base };
  switch (pi.status) {
    case "succeeded":
      status = "succeeded";
      fields.occurred_at = charge?.created ? new Date(charge.created * 1000).toISOString() : new Date().toISOString();
      break;
    case "processing":
      status = "processing";
      break;
    case "canceled":
      status = "canceled";
      break;
    case "requires_payment_method": {
      // Either a payment that never started, or one that failed. A card that
      // fails inside Checkout can be retried in the same page, so a failure on a
      // payment still waiting on that page is not final. A bank transfer that
      // failed after it was submitted, or an automatic charge, is.
      const error = pi.last_payment_error;
      if (!error) return "waiting";
      if (!options.finalFailure && payment.source === "portal" && payment.status === "pending") return "retryable";
      status = "failed";
      fields.failure_code = error.decline_code ?? error.code ?? null;
      fields.failure_message = friendlyFailure(error.code ?? error.decline_code, error.message);
      break;
    }
    default:
      return "waiting";   // requires_action, requires_confirmation, ...
  }
  const result = await rpc(deps.admin, "billing_apply_payment_update", { p_payment: payment.id, p_status: status, p_event_id: eventId, p_fields: fields });
  return `${status}:${result}`;
}

async function applyRefund(deps: EventDeps, refund: any, eventId: string): Promise<string> {
  const paymentIntent = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id ?? null;
  const charge = typeof refund.charge === "string" ? refund.charge : refund.charge?.id ?? null;
  return await rpc(deps.admin, "billing_apply_refund", {
    p_stripe_refund_id: refund.id, p_payment_intent: paymentIntent, p_stripe_charge: charge,
    p_amount_cents: refund.amount, p_status: refund.status, p_event_id: eventId,
    p_failure: refund.failure_reason ? String(refund.failure_reason) : null,
  }) as string;
}

/**
 * Applies one verified event. Returns a short word for the log. Throws when
 * something should be retried, which makes the webhook answer 500 so Stripe
 * delivers it again.
 */
export async function processStripeEvent(deps: EventDeps, event: StripeEvent): Promise<string> {
  const object = event.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const pi = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
      return pi ? await applyPaymentIntent(deps, pi, event.id) : "ignored";
    }
    case "checkout.session.async_payment_failed": {
      const pi = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
      return pi ? await applyPaymentIntent(deps, pi, event.id, { finalFailure: true }) : "ignored";
    }
    case "checkout.session.expired": {
      const paymentId = object.metadata?.payment_id ?? object.client_reference_id;
      if (!paymentId) return "ignored";
      await rpc(deps.admin, "billing_cancel_payment", { p_payment: paymentId, p_reason: "The checkout page expired before it was completed." });
      return "canceled";
    }
    case "payment_intent.processing":
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
      return await applyPaymentIntent(deps, object.id, event.id);

    case "charge.refunded": {
      const refunds = await deps.stripe.get("/v1/refunds", { charge: object.id, limit: 100 });
      const results: string[] = [];
      for (const refund of refunds?.data ?? []) results.push(await applyRefund(deps, refund, event.id));
      return `refunds:${results.join(",") || "none"}`;
    }
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated":
      return await applyRefund(deps, object, event.id);

    case "charge.dispute.created": {
      const pi = typeof object.payment_intent === "string" ? object.payment_intent : null;
      await rpc(deps.admin, "billing_flag_dispute", { p_payment_intent: pi, p_stripe_charge: typeof object.charge === "string" ? object.charge : null });
      return "dispute_flagged";
    }
    case "charge.dispute.closed": {
      // A lost dispute takes the money back, so the payment no longer counts.
      if (object.status !== "lost") return "ignored";
      const pi = typeof object.payment_intent === "string" ? object.payment_intent : null;
      const payment = pi ? await findPayment(deps.admin, { id: pi }) : null;
      if (!payment) return "not_ours";
      await rpc(deps.admin, "billing_apply_payment_update", {
        p_payment: payment.id, p_status: "failed", p_event_id: event.id,
        p_fields: { failure_code: "dispute_lost", failure_message: "The payment was reversed after a dispute." },
      });
      return "dispute_lost";
    }
    case "payment_method.detached": {
      // The saved method is gone, so automatic payments cannot use it.
      await deps.admin.from("billing_customers")
        .update({ autopay: false, stripe_payment_method_id: null, default_pm_type: null, default_pm_brand: null, default_pm_last4: null, default_pm_bank_name: null })
        .eq("stripe_payment_method_id", object.id);
      return "method_removed";
    }
    default:
      return "ignored";
  }
}
