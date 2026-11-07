/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { signStripePayload } from "./stripe.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";
import { handleStripeWebhook } from "./stripe-webhook.ts";

const NOW = 1_800_000_000;
const TEST_SECRET = "whsec_test_secret";
const LIVE_SECRET = "whsec_live_secret";

function build(over: { provider?: string; secrets?: Record<string, string>; claim?: string; applyError?: string } = {}) {
  const secrets = over.secrets ?? { STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_SECRET_KEY_TEST: "sk_test_x" };
  const admin = fakeAdmin({
    tables: { billing_settings: [{ id: "dues", provider: over.provider ?? "stripe_test" }], dues_payments: [{ id: "pay-1", status: "pending", source: "portal" }] },
    rpc: {
      read_vault_secret: (a) => ({ data: secrets[a.secret_name] ?? null }),
      stripe_claim_event: () => ({ data: over.claim ?? "new" }),
      stripe_finish_event: () => ({ data: null }),
      billing_apply_payment_update: () => (over.applyError ? { error: { message: over.applyError } } : { data: "applied" }),
      billing_cancel_payment: () => ({ data: null }),
    },
  });
  const stripe = fakeStripe({});
  return { admin, deps: { admin: admin.client, makeStripe: () => stripe.stripe, nowSeconds: NOW } };
}

async function post(body: unknown, secret = TEST_SECRET, tamper = false) {
  const raw = JSON.stringify(body);
  const header = await signStripePayload(raw, secret, NOW);
  return new Request("https://x.test/stripe-webhook", { method: "POST", headers: { "stripe-signature": header }, body: tamper ? raw + " " : raw });
}
const expired = { id: "evt_1", type: "checkout.session.expired", livemode: false, data: { object: { id: "cs_1", metadata: { payment_id: "pay-1" } } } };

Deno.test("webhook: a correctly signed event is applied and marked processed", async () => {
  const { admin, deps } = build();
  const response = await handleStripeWebhook(deps, await post(expired));
  assertEquals(response.status, 200);
  assertEquals(admin.called("billing_cancel_payment").length, 1);
  assertEquals(admin.called("stripe_finish_event")[0].args.p_error, null);
});

Deno.test("webhook: a bad, missing or tampered signature changes nothing", async () => {
  for (const make of [
    async () => await post(expired, "whsec_wrong"),
    async () => await post(expired, TEST_SECRET, true),
    () => Promise.resolve(new Request("https://x.test", { method: "POST", body: JSON.stringify(expired) })),
  ]) {
    const { admin, deps } = build();
    const response = await handleStripeWebhook(deps, await make());
    assertEquals(response.status, 400);
    assertEquals(admin.called("stripe_claim_event").length + admin.called("billing_cancel_payment").length, 0);
  }
});

Deno.test("webhook: with no webhook secret configured it refuses everything (503), even a well-formed request", async () => {
  const { admin, deps } = build({ secrets: {} });
  const response = await handleStripeWebhook(deps, await post(expired));
  assertEquals(response.status, 503);
  assertEquals(admin.calls.filter((c) => c.fn !== "read_vault_secret").length, 0);
});

Deno.test("webhook: only POST is accepted", async () => {
  const { deps } = build();
  assertEquals((await handleStripeWebhook(deps, new Request("https://x.test", { method: "GET" }))).status, 405);
});

Deno.test("webhook: an event delivered twice is applied once", async () => {
  const { admin, deps } = build({ claim: "processed" });
  const response = await handleStripeWebhook(deps, await post(expired));
  assertEquals(await response.json(), { ok: true, duplicate: true });
  assertEquals(admin.called("billing_cancel_payment").length, 0);
});

Deno.test("webhook: a live event while the app is in test mode is acknowledged and set aside, never applied", async () => {
  const { admin, deps } = build({ secrets: { STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_WEBHOOK_SECRET_LIVE: LIVE_SECRET, STRIPE_SECRET_KEY_TEST: "sk_test_x" } });
  const response = await handleStripeWebhook(deps, await post({ ...expired, livemode: true }, LIVE_SECRET));
  assertEquals((await response.json()).ignored, "mode");
  assertEquals(admin.called("billing_cancel_payment").length, 0);
  assertEquals(String(admin.called("stripe_finish_event")[0].args.p_error).includes("stripe_test"), true);
});

Deno.test("webhook: an event claiming to be live but signed with the test secret is set aside too", async () => {
  const { admin, deps } = build({ provider: "stripe_live", secrets: { STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_SECRET_KEY_LIVE: "sk_live_x" } });
  const response = await handleStripeWebhook(deps, await post({ ...expired, livemode: true }, TEST_SECRET));
  assertEquals((await response.json()).ignored, "mode");
  assertEquals(admin.called("billing_cancel_payment").length, 0);
});

Deno.test("webhook: when applying fails it answers 500 so Stripe retries, and records why", async () => {
  const failing = { id: "evt_2", type: "payment_intent.succeeded", livemode: false, data: { object: { id: "pi_1" } } };
  const stripe = fakeStripe({
    "GET /v1/payment_intents/pi_1": { id: "pi_1", status: "succeeded", metadata: { payment_id: "pay-1" }, latest_charge: { id: "ch_1", payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } } } },
  });
  const broken = fakeAdmin({
    tables: { billing_settings: [{ id: "dues", provider: "stripe_test" }], dues_payments: [{ id: "pay-1", status: "pending", source: "portal" }] },
    rpc: {
      read_vault_secret: (a) => ({ data: ({ STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET, STRIPE_SECRET_KEY_TEST: "sk_test_x" } as Record<string, string>)[a.secret_name] ?? null }),
      stripe_claim_event: () => ({ data: "new" }), stripe_finish_event: () => ({ data: null }),
      billing_apply_payment_update: () => ({ error: { message: "deadlock detected" } }),
    },
  });
  const response = await handleStripeWebhook({ admin: broken.client, makeStripe: () => stripe.stripe, nowSeconds: NOW }, await post(failing));
  assertEquals(response.status, 500);
  assertEquals(String(broken.called("stripe_finish_event")[0].args.p_error).includes("deadlock"), true);
});

Deno.test("webhook: when the Stripe key is missing the event is kept and Stripe is told to retry later", async () => {
  const { admin, deps } = build({ secrets: { STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET } });
  const response = await handleStripeWebhook(deps, await post(expired));
  assertEquals(response.status, 503);
  assertEquals(admin.called("billing_cancel_payment").length, 0);
});
