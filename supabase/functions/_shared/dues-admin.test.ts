/// <reference lib="deno.ns" />
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { cancelPendingPayment, reconcileWithStripe, refundDuesPayment, syncPendingPayments } from "./dues-admin.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

const refundRow = { refund_id: "ref-1", payment_intent_id: "pi_1", amount_cents: 10000, idempotency_key: "ref_ref-1", livemode: false };
const input = { actorId: "admin-1", paymentId: "pay-1", amountCents: 10000, reason: "Withdrew a child", reduceOwed: true };

Deno.test("refund: Stripe is asked with the database's idempotency key, then the books move", async () => {
  const admin = fakeAdmin({ rpc: { billing_begin_refund: () => ({ data: refundRow }), billing_attach_refund: () => ({ data: null }) } });
  const stripe = fakeStripe({ "POST /v1/refunds": { id: "re_1", status: "succeeded" } });
  const result = await refundDuesPayment({ admin: admin.client, stripe: stripe.stripe }, input);
  assertEquals(result, { ok: true, refundId: "ref-1" });
  const request = stripe.requests[0];
  assertEquals([request.params["payment_intent"], request.params["amount"], request.headers["Idempotency-Key"]], ["pi_1", "10000", "ref_ref-1"]);
  assertEquals(admin.called("billing_attach_refund")[0].args, { p_refund: "ref-1", p_stripe_refund_id: "re_1", p_status: "succeeded", p_reduce_owed: true });
});

Deno.test("refund: the database's refusal (too much, no approval) is passed on and Stripe is never called", async () => {
  const admin = fakeAdmin({ rpc: { billing_begin_refund: () => ({ error: { message: "This action needs an approval from a second administrator.", code: "42501" } }) } });
  const stripe = fakeStripe({});
  const result = await refundDuesPayment({ admin: admin.client, stripe: stripe.stripe }, input);
  assertEquals(!result.ok && result.status, 403);
  assertStringIncludes(!result.ok ? result.error : "", "second administrator");
  assertEquals(stripe.requests.length, 0);
});

Deno.test("refund: if Stripe refuses, the pending refund is canceled and the owed amount is untouched", async () => {
  const admin = fakeAdmin({ rpc: { billing_begin_refund: () => ({ data: refundRow }), billing_cancel_payment: () => ({ data: null }) } });
  const stripe = fakeStripe({ "POST /v1/refunds": () => ({ status: 400, body: { error: { message: "Charge ch_1 has already been refunded." } } }) });
  const result = await refundDuesPayment({ admin: admin.client, stripe: stripe.stripe }, input);
  assertEquals(!result.ok && result.status, 502);
  assertEquals(admin.called("billing_cancel_payment")[0].args.p_payment, "ref-1");
  assertEquals(admin.called("billing_attach_refund").length, 0);
});

Deno.test("sync: asks Stripe about each pending payment and refund, and reports what changed", async () => {
  const stripe = fakeStripe({
    "GET /v1/payment_intents/pi_1": { id: "pi_1", status: "succeeded", payment_method: "pm_1", metadata: { payment_id: "p1" }, latest_charge: { id: "ch_1", payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } } },
    "GET /v1/checkout/sessions/cs_2": { id: "cs_2", status: "expired", payment_intent: null },
    "GET /v1/refunds/re_1": { id: "re_1", amount: 1000, status: "succeeded", payment_intent: "pi_1", charge: "ch_1" },
  });
  const withPay = fakeAdmin({
    tables: { dues_payments: [{ id: "p1", status: "processing", source: "portal", direction: "charge", stripe_payment_intent_id: "pi_1", stripe_checkout_session_id: "cs_1", stripe_refund_id: null },
      { id: "p2", direction: "charge", status: "pending", source: "portal", stripe_payment_intent_id: null, stripe_checkout_session_id: "cs_2", stripe_refund_id: null },
      { id: "r1", direction: "refund", status: "pending", source: "admin_manual", stripe_payment_intent_id: null, stripe_checkout_session_id: null, stripe_refund_id: "re_1" }] },
    rpc: { billing_apply_payment_update: () => ({ data: "applied" }), billing_apply_refund: () => ({ data: "applied" }), billing_cancel_payment: () => ({ data: null }) },
  });
  const result = await syncPendingPayments({ admin: withPay.client, stripe: stripe.stripe });
  assertEquals([result.checked, result.changed, result.notes], [3, 3, []]);
  assertEquals(withPay.called("billing_cancel_payment")[0].args.p_payment, "p2");
});

Deno.test("cancel: only an unstarted payment can be canceled, and its Checkout page is closed", async () => {
  const admin = fakeAdmin({ tables: { dues_payments: [{ id: "p1", status: "pending", direction: "charge", stripe_checkout_session_id: "cs_1" }, { id: "p2", status: "processing", direction: "charge", stripe_checkout_session_id: null }] }, rpc: { billing_cancel_payment: () => ({ data: null }) } });
  const stripe = fakeStripe({ "POST /v1/checkout/sessions/cs_1/expire": { id: "cs_1", status: "expired" } });
  assertEquals((await cancelPendingPayment({ admin: admin.client, stripe: stripe.stripe }, "p1")).ok, true);
  assertEquals(stripe.requests.length, 1);
  const blocked = await cancelPendingPayment({ admin: admin.client, stripe: stripe.stripe }, "p2");
  assertEquals(!blocked.ok && blocked.status, 409);
});

Deno.test("reconcile: lists settled payments that Stripe does not agree are settled", async () => {
  const admin = fakeAdmin({ tables: { dues_payments: [
    { id: "p1", status: "succeeded", direction: "charge", stripe_payment_intent_id: "pi_1" },
    { id: "p2", status: "succeeded", direction: "charge", stripe_payment_intent_id: "pi_2" },
  ] } });
  const stripe = fakeStripe({ "GET /v1/payment_intents/pi_1": { status: "succeeded" }, "GET /v1/payment_intents/pi_2": { status: "canceled" } });
  const result = await reconcileWithStripe({ admin: admin.client, stripe: stripe.stripe });
  assertEquals(result, { checked: 2, mismatches: [{ paymentId: "p2", local: "succeeded", stripe: "canceled" }] });
});
