/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { processStripeEvent } from "./stripe-events.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

const payment = (over: Record<string, unknown> = {}) => ({ id: "pay-1", status: "pending", source: "portal", ...over });
const cardCharge = { id: "ch_1", created: 1_790_000_000, receipt_url: "https://pay.stripe.com/r/1", payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", wallet: { type: "apple_pay" } } } };
const bankCharge = { id: "ch_2", created: 1_790_000_000, payment_method_details: { type: "us_bank_account", us_bank_account: { bank_name: "STRIPE TEST BANK", last4: "6789" } } };
const pi = (over: Record<string, unknown> = {}) => ({ id: "pi_1", status: "succeeded", payment_method: "pm_1", mandate: null, metadata: { payment_id: "pay-1" }, latest_charge: "ch_1", ...over });
const event = (type: string, object: unknown) => ({ id: "evt_1", type, livemode: false, data: { object } });

function setup(opts: { payments?: unknown[]; routes?: Record<string, unknown> } = {}) {
  const admin = fakeAdmin({
    tables: { dues_payments: opts.payments ?? [payment()] },
    rpc: { billing_apply_payment_update: () => ({ data: "applied" }), billing_apply_refund: () => ({ data: "applied" }) },
  });
  const stripe = fakeStripe({ "GET /v1/charges/ch_1": cardCharge, "GET /v1/charges/ch_2": bankCharge, ...opts.routes });
  return { admin, stripe, deps: { admin: admin.client, stripe: stripe.stripe } };
}

Deno.test("a settled card payment is read back from Stripe and applied with display facts only", async () => {
  const { admin, deps } = setup({ routes: { "GET /v1/payment_intents/pi_1": pi() } });
  const result = await processStripeEvent(deps, event("payment_intent.succeeded", { id: "pi_1", status: "processing" /* stale payload */ }));
  assertEquals(result, "succeeded:applied");
  const [call] = admin.called("billing_apply_payment_update");
  assertEquals(call.args.p_payment, "pay-1");
  assertEquals(call.args.p_status, "succeeded", "uses Stripe's current state, not the event's stale one");
  assertEquals(call.args.p_fields.wallet, "apple_pay");
  assertEquals(call.args.p_fields.last4, "4242");
  assertEquals(call.args.p_fields.payment_method_id, "pm_1");
  assertEquals(Object.keys(call.args.p_fields).filter((k) => /number|cvc|account/i.test(k)), [], "no card or account numbers");
});

Deno.test("a bank transfer that is still clearing is 'processing', not paid", async () => {
  const { admin, deps } = setup({ routes: { "GET /v1/payment_intents/pi_1": pi({ status: "processing", latest_charge: "ch_2" }) } });
  await processStripeEvent(deps, event("payment_intent.processing", { id: "pi_1" }));
  const [call] = admin.called("billing_apply_payment_update");
  assertEquals(call.args.p_status, "processing");
  assertEquals(call.args.p_fields.bank_name, "STRIPE TEST BANK");
});

Deno.test("Checkout completing hands off to the PaymentIntent, so ACH is 'processing' and a card is 'succeeded'", async () => {
  const { admin, deps } = setup({ routes: { "GET /v1/payment_intents/pi_1": pi({ status: "processing", latest_charge: "ch_2" }) } });
  await processStripeEvent(deps, event("checkout.session.completed", { id: "cs_1", payment_intent: "pi_1", payment_status: "unpaid" }));
  assertEquals(admin.called("billing_apply_payment_update")[0].args.p_status, "processing");
});

Deno.test("a card that fails inside Checkout is not final while the page can still be retried", async () => {
  const failing = pi({ status: "requires_payment_method", last_payment_error: { code: "card_declined", message: "Your card was declined." } });
  const { admin, deps } = setup({ routes: { "GET /v1/payment_intents/pi_1": failing } });
  assertEquals(await processStripeEvent(deps, event("payment_intent.payment_failed", { id: "pi_1" })), "retryable");
  assertEquals(admin.called("billing_apply_payment_update").length, 0);
});

Deno.test("a bank transfer that fails after it was submitted is final, with a plain reason", async () => {
  const failing = pi({ status: "requires_payment_method", last_payment_error: { code: "insufficient_funds", message: "raw" } });
  const { admin, deps } = setup({ payments: [payment({ status: "processing" })], routes: { "GET /v1/payment_intents/pi_1": failing } });
  await processStripeEvent(deps, event("payment_intent.payment_failed", { id: "pi_1" }));
  const [call] = admin.called("billing_apply_payment_update");
  assertEquals(call.args.p_status, "failed");
  assertEquals(call.args.p_fields.failure_message, "Your bank reported insufficient funds.");
});

Deno.test("an automatic charge that is declined is final", async () => {
  const failing = pi({ status: "requires_payment_method", last_payment_error: { code: "card_declined", message: "declined" } });
  const { admin, deps } = setup({ payments: [payment({ source: "autopay" })], routes: { "GET /v1/payment_intents/pi_1": failing } });
  await processStripeEvent(deps, event("payment_intent.payment_failed", { id: "pi_1" }));
  assertEquals(admin.called("billing_apply_payment_update")[0].args.p_status, "failed");
});

Deno.test("a PaymentIntent that did not come from the portal is left alone", async () => {
  const { admin, deps } = setup({ payments: [], routes: { "GET /v1/payment_intents/pi_9": pi({ id: "pi_9", metadata: {} }) } });
  assertEquals(await processStripeEvent(deps, event("payment_intent.succeeded", { id: "pi_9" })), "not_ours");
  assertEquals(admin.called("billing_apply_payment_update").length, 0);
});

Deno.test("an expired Checkout page cancels its pending attempt", async () => {
  const { admin, deps } = setup();
  await processStripeEvent(deps, event("checkout.session.expired", { id: "cs_1", metadata: { payment_id: "pay-1" } }));
  assertEquals(admin.called("billing_cancel_payment")[0].args.p_payment, "pay-1");
});

Deno.test("refunds: charge.refunded lists the refunds from Stripe and records each once; a dashboard refund is a refund too", async () => {
  const { admin, deps } = setup({ routes: { "GET /v1/refunds": { data: [
    { id: "re_1", amount: 1000, status: "succeeded", payment_intent: "pi_1", charge: "ch_1" },
    { id: "re_2", amount: 500, status: "pending", payment_intent: "pi_1", charge: "ch_1" },
  ] } } });
  await processStripeEvent(deps, event("charge.refunded", { id: "ch_1" }));
  assertEquals(admin.called("billing_apply_refund").map((c) => [c.args.p_stripe_refund_id, c.args.p_amount_cents, c.args.p_status]),
    [["re_1", 1000, "succeeded"], ["re_2", 500, "pending"]]);
  await processStripeEvent(deps, event("refund.updated", { id: "re_3", amount: 200, status: "failed", payment_intent: "pi_1", charge: "ch_1", failure_reason: "expired_or_canceled_card" }));
  assertEquals(admin.called("billing_apply_refund").at(-1)!.args.p_failure, "expired_or_canceled_card");
});

Deno.test("a dispute is flagged for an administrator; losing it reverses the payment", async () => {
  const { admin, deps } = setup();
  await processStripeEvent(deps, event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", charge: "ch_1" }));
  assertEquals(admin.called("billing_flag_dispute").length, 1);
  assertEquals(await processStripeEvent(deps, event("charge.dispute.closed", { id: "dp_1", status: "won", payment_intent: "pi_1" })), "ignored");

  const lost = setup({ payments: [{ id: "pay-1", status: "succeeded", source: "portal", stripe_payment_intent_id: "pi_1" }] });
  await processStripeEvent(lost.deps, event("charge.dispute.closed", { id: "dp_1", status: "lost", payment_intent: "pi_1" }));
  assertEquals(lost.admin.called("billing_apply_payment_update")[0].args.p_fields.failure_code, "dispute_lost");
});

Deno.test("a database error is thrown, so the webhook answers 500 and Stripe retries", async () => {
  const admin = fakeAdmin({ tables: { dues_payments: [payment()] }, rpc: { billing_apply_payment_update: () => ({ error: { message: "deadlock detected" } }) } });
  const stripe = fakeStripe({ "GET /v1/payment_intents/pi_1": pi(), "GET /v1/charges/ch_1": cardCharge });
  let thrown = "";
  await processStripeEvent({ admin: admin.client, stripe: stripe.stripe }, event("payment_intent.succeeded", { id: "pi_1" })).catch((e) => { thrown = e.message; });
  assertEquals(thrown.includes("deadlock"), true);
});

Deno.test("event types the app does not use are acknowledged and ignored", async () => {
  const { deps } = setup();
  assertEquals(await processStripeEvent(deps, event("customer.created", { id: "cus_1" })), "ignored");
});
