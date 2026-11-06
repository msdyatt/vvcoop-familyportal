/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { runDuesDaily } from "./dues-jobs.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

const begun = { payment_id: "pay-9", amount_cents: 13500, family_id: "fam-1", charge_id: "charge-1", stripe_customer_id: "cus_1", payment_method_id: "pm_1", method: "us_bank_account", livemode: false };
const autopayPayment = { id: "pay-9", status: "pending", source: "autopay" };

function setup(over: { routes?: Record<string, unknown>; begin?: () => { data?: unknown; error?: { message: string } } } = {}) {
  const admin = fakeAdmin({
    tables: { dues_payments: [autopayPayment] },
    rpc: {
      billing_expire_stale: () => ({ data: 1 }), billing_queue_reminders: () => ({ data: 2 }), billing_prune_webhook_events: () => ({ data: 0 }),
      billing_due_autopay: () => ({ data: [{ installment_id: "inst-2" }] }),
      billing_begin_autopay: over.begin ?? (() => ({ data: begun })),
      billing_apply_payment_update: () => ({ data: "applied" }),
    },
  });
  const stripe = fakeStripe({ "GET /v1/charges/ch_1": { id: "ch_1", payment_method_details: { type: "us_bank_account", us_bank_account: { last4: "6789", bank_name: "B" } } }, ...over.routes });
  return { admin, stripe };
}

Deno.test("daily run without Stripe configured still does the housekeeping and reminders, and charges nobody", async () => {
  const { admin } = setup();
  const summary = await runDuesDaily({ admin: admin.client, stripe: null }, "2026-10-01");
  assertEquals([summary.expired, summary.reminders, summary.autopay.attempted], [1, 2, 0]);
  assertEquals(admin.called("billing_begin_autopay").length, 0);
});

Deno.test("daily run: the pending row exists before Stripe is called, and its id is the idempotency key", async () => {
  const { admin, stripe } = setup({ routes: { "POST /v1/payment_intents": { id: "pi_5", status: "processing", payment_method: "pm_1", metadata: { payment_id: "pay-9" }, latest_charge: "ch_1" } } });
  const summary = await runDuesDaily({ admin: admin.client, stripe: stripe.stripe }, "2026-10-01");
  assertEquals(summary.autopay, { attempted: 1, started: 1, failed: 0, skipped: 0 });
  const request = stripe.requests.find((r) => r.path === "/v1/payment_intents")!;
  assertEquals(request.headers["Idempotency-Key"], "pay_pay-9");
  assertEquals(request.params["amount"], "13500");
  assertEquals(request.params["off_session"], "true");
  assertEquals(request.params["confirm"], "true");
  assertEquals(request.params["payment_method_types[0]"], "us_bank_account");
  assertEquals(request.params["metadata[source]"], "autopay");
  assertEquals(admin.calls.findIndex((c) => c.fn === "billing_begin_autopay") < admin.calls.length - 1, true);
});

Deno.test("daily run: a declined card is recorded as a failure and counted, not retried the same day", async () => {
  const declined = { error: { message: "Your card was declined.", code: "card_declined", type: "card_error", payment_intent: { id: "pi_6", status: "requires_payment_method", payment_method: "pm_1", metadata: { payment_id: "pay-9" }, last_payment_error: { code: "card_declined", message: "declined" }, latest_charge: null } } };
  const { admin, stripe } = setup({ routes: { "POST /v1/payment_intents": () => ({ status: 402, body: declined }) } });
  const summary = await runDuesDaily({ admin: admin.client, stripe: stripe.stripe }, "2026-10-01");
  assertEquals(summary.autopay.failed, 1);
  const update = admin.called("billing_apply_payment_update")[0];
  assertEquals([update.args.p_status, update.args.p_fields.failure_message], ["failed", "Your card was declined."]);
});

Deno.test("daily run: if Stripe cannot be reached the row is left pending and the run carries on", async () => {
  const { admin } = setup();
  const offline = (await import("./stripe.ts")).StripeClient;
  const stripe = new offline("sk_test_x", () => Promise.reject(new Error("network down")));
  const summary = await runDuesDaily({ admin: admin.client, stripe }, "2026-10-01");
  assertEquals(summary.autopay, { attempted: 1, started: 0, failed: 0, skipped: 1 });
  assertEquals(admin.called("billing_apply_payment_update").length, 0);
});

Deno.test("daily run: an installment another run already took is skipped quietly", async () => {
  const { admin, stripe } = setup({ begin: () => ({ error: { message: "payment_in_flight" } }) });
  const summary = await runDuesDaily({ admin: admin.client, stripe: stripe.stripe }, "2026-10-01");
  assertEquals(summary.autopay, { attempted: 1, started: 0, failed: 0, skipped: 1 });
  assertEquals(stripe.requests.length, 0);
});
