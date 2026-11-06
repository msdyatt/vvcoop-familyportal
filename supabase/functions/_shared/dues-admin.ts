import { applyFetchedPaymentIntent, applyPaymentIntent } from "./stripe-events.ts";
import { StripeError, type StripeClient } from "./stripe.ts";
import type { AdminClient } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

type Deps = { admin: AdminClient; stripe: StripeClient };
export type ActionResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export async function refundDuesPayment(
  deps: Deps,
  input: { actorId: string; paymentId: string; amountCents: number; reason: string; reduceOwed: boolean; approvalId?: string | null },
): Promise<ActionResult<{ refundId: string }>> {
  const { admin, stripe } = deps;
  const begun = await admin.rpc("billing_begin_refund", {
    p_actor: input.actorId, p_payment: input.paymentId, p_amount_cents: input.amountCents,
    p_reason: input.reason, p_approval: input.approvalId ?? null,
  });
  if (begun.error) {
    // These are written for people ("That is more than is left to refund...").
    return { ok: false, status: begun.error.code === "42501" ? 403 : 400, error: begun.error.message };
  }
  const refund = begun.data as { refund_id: string; payment_intent_id: string; amount_cents: number; idempotency_key: string };
  try {
    const made = await stripe.post("/v1/refunds", {
      payment_intent: refund.payment_intent_id, amount: refund.amount_cents,
      reason: "requested_by_customer", metadata: { refund_id: refund.refund_id, payment_id: input.paymentId },
    }, refund.idempotency_key);
    const attached = await admin.rpc("billing_attach_refund", {
      p_refund: refund.refund_id, p_stripe_refund_id: made.id, p_status: made.status, p_reduce_owed: input.reduceOwed,
    });
    if (attached.error) throw new Error(`billing_attach_refund: ${attached.error.message}`);
    return { ok: true, refundId: refund.refund_id };
  } catch (error) {
    if (error instanceof StripeError) {
      await admin.rpc("billing_cancel_payment", { p_payment: refund.refund_id, p_reason: `Stripe refused the refund: ${error.message}` });
      return { ok: false, status: 502, error: `Stripe refused the refund: ${error.message}. Nothing was changed. A live refund approval is used up, so ask for a new one.` };
    }
    throw error;
  }
}

/** Asks Stripe about everything still pending, in case a webhook was missed. */
export async function syncPendingPayments(deps: Deps): Promise<{ checked: number; changed: number; notes: string[] }> {
  const { admin, stripe } = deps;
  const notes: string[] = [];
  let changed = 0;
  const { data } = await admin.from("dues_payments")
    .select("id,direction,status,stripe_checkout_session_id,stripe_payment_intent_id,stripe_refund_id")
    .in("status", ["pending", "processing"]).order("created_at").limit(100);
  const rows = (data ?? []) as any[];

  for (const row of rows) {
    try {
      if (row.direction === "refund") {
        if (!row.stripe_refund_id) continue;
        const refund = await stripe.get(`/v1/refunds/${row.stripe_refund_id}`);
        const result = await admin.rpc("billing_apply_refund", {
          p_stripe_refund_id: refund.id, p_payment_intent: refund.payment_intent ?? null, p_stripe_charge: refund.charge ?? null,
          p_amount_cents: refund.amount, p_status: refund.status, p_event_id: null, p_failure: refund.failure_reason ?? null,
        });
        if (result.data === "applied") changed++;
        continue;
      }
      let paymentIntentId: string | null = row.stripe_payment_intent_id;
      if (!paymentIntentId && row.stripe_checkout_session_id) {
        const session = await stripe.get(`/v1/checkout/sessions/${row.stripe_checkout_session_id}`);
        paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
        if (!paymentIntentId && session.status === "expired") {
          await admin.rpc("billing_cancel_payment", { p_payment: row.id, p_reason: "The checkout page expired." });
          changed++;
          continue;
        }
      }
      if (!paymentIntentId) continue;
      const outcome = await applyPaymentIntent(deps, paymentIntentId, null, { finalFailure: row.status === "processing" });
      if (outcome.endsWith(":applied")) changed++;
    } catch (error) {
      notes.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { checked: rows.length, changed, notes };
}

/** Admin cancels an attempt that is stuck pending (closes the Checkout page too). */
export async function cancelPendingPayment(deps: Deps, paymentId: string): Promise<ActionResult> {
  const { admin, stripe } = deps;
  const { data } = await admin.from("dues_payments").select("id,status,direction,stripe_checkout_session_id").eq("id", paymentId).maybeSingle();
  if (!data || data.status !== "pending" || data.direction !== "charge") {
    return { ok: false, status: 409, error: "Only a payment that has not started processing can be canceled." };
  }
  if (data.stripe_checkout_session_id) {
    try { await stripe.post(`/v1/checkout/sessions/${data.stripe_checkout_session_id}/expire`, {}); } catch { /* already closed */ }
  }
  await admin.rpc("billing_cancel_payment", { p_payment: paymentId, p_reason: "Canceled by an administrator." });
  return { ok: true };
}

/** Compares recent settled payments with what Stripe says, and lists any that disagree. */
export async function reconcileWithStripe(deps: Deps, limit = 50): Promise<{ checked: number; mismatches: { paymentId: string; local: string; stripe: string }[] }> {
  const { admin, stripe } = deps;
  const { data } = await admin.from("dues_payments")
    .select("id,status,stripe_payment_intent_id").eq("direction", "charge").eq("status", "succeeded")
    .not("stripe_payment_intent_id", "is", null).order("occurred_at", { ascending: false }).limit(limit);
  const mismatches: { paymentId: string; local: string; stripe: string }[] = [];
  for (const row of (data ?? []) as any[]) {
    const pi = await stripe.get(`/v1/payment_intents/${row.stripe_payment_intent_id}`);
    if (pi.status !== "succeeded") mismatches.push({ paymentId: row.id, local: row.status, stripe: pi.status });
  }
  return { checked: (data ?? []).length, mismatches };
}

/** The Stripe account behind the key, so an administrator can see it is the right one. */
export async function describeAccount(stripe: StripeClient) {
  const account = await stripe.get("/v1/account");
  return {
    id: account.id as string,
    name: (account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null) as string | null,
    country: (account.country ?? null) as string | null,
    chargesEnabled: Boolean(account.charges_enabled),
  };
}

export { applyFetchedPaymentIntent };
