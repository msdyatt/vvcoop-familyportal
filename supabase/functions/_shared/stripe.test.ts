/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  describeCharge, encodeForm, friendlyFailure, loadStripeConfig, signStripePayload, StripeError, STRIPE_API_VERSION, verifyStripeSignature,
} from "./stripe.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

Deno.test("encodeForm: nests objects and arrays the way Stripe expects, and drops empties", () => {
  const out = decodeURIComponent(encodeForm({
    mode: "payment", payment_method_types: ["us_bank_account", "card"],
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 60000 } }],
    metadata: { payment_id: "abc", empty: undefined, nothing: null }, confirm: true,
  }));
  assertEquals(out.split("&").sort(), [
    "confirm=true", "line_items[0][price_data][currency]=usd", "line_items[0][price_data][unit_amount]=60000", "line_items[0][quantity]=1",
    "metadata[payment_id]=abc", "mode=payment", "payment_method_types[0]=us_bank_account", "payment_method_types[1]=card",
  ]);
});

Deno.test("StripeClient: sends the key, a pinned API version and the idempotency key; surfaces Stripe's message on failure", async () => {
  const { stripe, requests } = fakeStripe({
    "POST /v1/customers": { id: "cus_1" },
    "POST /v1/refunds": () => ({ status: 402, body: { error: { message: "Charge already refunded", code: "charge_already_refunded", type: "invalid_request_error" } } }),
  });
  const customer = await stripe.post("/v1/customers", { name: "Smith" }, "cust_key");
  assertEquals(customer.id, "cus_1");
  assertEquals(requests[0].headers["Idempotency-Key"], "cust_key");
  assertEquals(requests[0].headers["Stripe-Version"], STRIPE_API_VERSION);
  assertEquals(requests[0].headers.Authorization, "Bearer sk_test_fake");
  const error = await stripe.post("/v1/refunds", {}).catch((e) => e);
  assert(error instanceof StripeError);
  assertEquals(error.code, "charge_already_refunded");
  assertStringIncludes(error.message, "already refunded");
});

Deno.test("verifyStripeSignature: accepts Stripe's scheme, rejects a changed body, wrong secret, old timestamp and junk", async () => {
  const body = '{"id":"evt_1"}';
  const secret = "whsec_test";
  const t = 1_800_000_000;
  const header = await signStripePayload(body, secret, t);
  assert(await verifyStripeSignature(body, header, secret, t + 10));
  assertFalse(await verifyStripeSignature(body + " ", header, secret, t + 10), "a changed body");
  assertFalse(await verifyStripeSignature(body, header, "whsec_other", t + 10), "another secret");
  assertFalse(await verifyStripeSignature(body, header, secret, t + 3600), "a replay an hour later");
  assertFalse(await verifyStripeSignature(body, null, secret, t));
  assertFalse(await verifyStripeSignature(body, "garbage", secret, t));
  assertFalse(await verifyStripeSignature(body, header, "", t));
  // During secret rotation Stripe sends two v1 values; either may match.
  const rotated = `${header},v1=${"0".repeat(64)}`;
  assert(await verifyStripeSignature(body, rotated, secret, t + 1));
});

Deno.test("loadStripeConfig: off, no key, wrong-mode key and a good key are each told apart", async () => {
  const withSecrets = (provider: string, secrets: Record<string, string>) => fakeAdmin({
    tables: { billing_settings: [{ id: "dues", provider }] },
    rpc: { read_vault_secret: (args) => ({ data: secrets[args.secret_name] ?? null }) },
  }).client;

  const off = await loadStripeConfig(withSecrets("off", {}));
  assert(!off.ok && off.code === "off");

  const none = await loadStripeConfig(withSecrets("stripe_test", {}));
  assert(!none.ok && none.code === "no_key");
  assertStringIncludes(none.ok ? "" : none.message, "STRIPE_SECRET_KEY_TEST");

  // A live key must never be used while the app thinks it is in test mode, or the reverse.
  const mismatch = await loadStripeConfig(withSecrets("stripe_test", { STRIPE_SECRET_KEY_TEST: "sk_live_abc" }));
  assert(!mismatch.ok && mismatch.code === "wrong_key");
  const mismatchLive = await loadStripeConfig(withSecrets("stripe_live", { STRIPE_SECRET_KEY_LIVE: "sk_test_abc" }));
  assert(!mismatchLive.ok && mismatchLive.code === "wrong_key");

  const good = await loadStripeConfig(withSecrets("stripe_test", { STRIPE_SECRET_KEY_TEST: "sk_test_abc " }));
  assert(good.ok);
  if (good.ok) { assertEquals(good.livemode, false); assertEquals(good.secretKey, "sk_test_abc"); }
  if (good.ok) assertEquals(good.publishableKey, null, "optional: the app falls back to Stripe's own page without it");
  const withPk = await loadStripeConfig(withSecrets("stripe_test", { STRIPE_SECRET_KEY_TEST: "sk_test_abc", STRIPE_PUBLISHABLE_KEY_TEST: "pk_test_123" }));
  assert(withPk.ok && withPk.publishableKey === "pk_test_123");
  const wrongPk = await loadStripeConfig(withSecrets("stripe_test", { STRIPE_SECRET_KEY_TEST: "sk_test_abc", STRIPE_PUBLISHABLE_KEY_TEST: "pk_live_123" }));
  assert(wrongPk.ok && wrongPk.publishableKey === null, "a live publishable key is never used in test mode");
  const restricted = await loadStripeConfig(withSecrets("stripe_live", { STRIPE_SECRET_KEY_LIVE: "rk_live_abc" }));
  assert(restricted.ok && restricted.livemode);
});

Deno.test("describeCharge: keeps only brand, last four, bank name and wallet", () => {
  assertEquals(describeCharge({ id: "ch_1", receipt_url: "https://pay.stripe.com/r", payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", number: "SHOULD-NEVER-APPEAR", wallet: { type: "apple_pay" } } } }),
    { method: "card", wallet: "apple_pay", brand: "visa", last4: "4242", bank_name: null, receipt_url: "https://pay.stripe.com/r", charge_id: "ch_1" });
  const bank = describeCharge({ id: "ch_2", payment_method_details: { type: "us_bank_account", us_bank_account: { bank_name: "STRIPE TEST BANK", last4: "6789" } } });
  assertEquals([bank.method, bank.bank_name, bank.last4], ["us_bank_account", "STRIPE TEST BANK", "6789"]);
  assertEquals(describeCharge({ payment_method_details: { type: "card", card: { brand: "visa", last4: "42; drop table", wallet: { type: "samsung_pay" } } } }).last4, null);
  assertEquals(describeCharge({ payment_method_details: { type: "card", card: { wallet: { type: "samsung_pay" } } } }).wallet, "other");
  assertEquals(describeCharge(undefined).method, null);
});

Deno.test("friendlyFailure: plain wording for common bank and card failures", () => {
  assertEquals(friendlyFailure("insufficient_funds", "x"), "Your bank reported insufficient funds.");
  assertEquals(friendlyFailure("card_declined", "x"), "Your card was declined.");
  assertEquals(friendlyFailure("something_new", "Odd thing"), "Odd thing");
  assertEquals(friendlyFailure(null, null), "The payment did not go through.");
});
