/// <reference lib="deno.ns" />
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createDuesCheckout } from "./dues-checkout.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

const config = { ok: true as const, provider: "stripe_test" as const, livemode: false, secretKey: "sk_test_fake", publishableKey: null };
const embeddedConfig = { ...config, publishableKey: "pk_test_fake" };
const input = { userId: "u1", userEmail: "mom@example.test", chargeId: "charge-1" };
const started = { payment_id: "pay-1", amount_cents: 60000, existing: false, status: "pending", family_id: "fam-1", saved_for_autopay: false, installment_id: null };
const tables = {
  dues_charges: [{ id: "charge-1", family_id: "fam-1", families: { display_name: "The Smith family" }, requirements: { title: "Dues" }, school_years: { label: "2026-27" } }],
  billing_customers: [] as unknown[],
};

function setup(over: { begin?: unknown; tables?: Record<string, unknown[]>; routes?: Record<string, unknown> } = {}) {
  const admin = fakeAdmin({
    tables: (over.tables ?? tables) as never,
    rpc: { billing_begin_payment: () => (over.begin as never) ?? { data: started }, billing_attach_checkout: () => ({ data: null }), billing_set_customer: () => ({ data: null }), billing_cancel_payment: () => ({ data: null }) },
  });
  const stripe = fakeStripe({
    "POST /v1/customers": { id: "cus_1" },
    "POST /v1/checkout/sessions": { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" },
    ...over.routes,
  });
  return { admin, stripe, deps: { admin: admin.client, stripe: stripe.stripe, config, nowSeconds: 1_790_000_000 } };
}

Deno.test("checkout: the amount comes from the database, bank transfer is offered first, and the page cannot choose it", async () => {
  const { admin, stripe, deps } = setup();
  const result = await createDuesCheckout(deps, { ...input, payAll: false });
  assertEquals(result, { ok: true, kind: "hosted", url: "https://checkout.stripe.com/c/pay/cs_1", paymentId: "pay-1" });
  const session = stripe.requests.find((r) => r.path === "/v1/checkout/sessions")!;
  assertEquals(session.params["line_items[0][price_data][unit_amount]"], "60000");
  assertEquals(session.params["payment_method_types[0]"], "us_bank_account");
  assertEquals(session.params["payment_method_types[1]"], "card");
  assertEquals(session.params["mode"], "payment");
  assertEquals(session.params["adaptive_pricing[enabled]"], "false", "no currency conversion");
  assertEquals(session.params["customer"], "cus_1");
  assertEquals(session.params["payment_intent_data[metadata][payment_id]"], "pay-1");
  assertEquals(session.params["payment_intent_data[setup_future_usage]"], undefined, "no card is saved unless the household agreed to automatic payments");
  assertEquals(session.headers["Idempotency-Key"], "pay-1");
  assertStringIncludes(session.params["success_url"], "https://family.veritasvillage.org/family-village/dues");
  assertEquals(Number(session.params["expires_at"]) - 1_790_000_000, 31 * 60);
  assertEquals(admin.called("billing_attach_checkout")[0].args, { p_payment: "pay-1", p_session_id: "cs_1" });
  assertEquals(admin.called("billing_begin_payment")[0].args.p_user, "u1");
});

Deno.test("checkout: agreeing to automatic payments saves the method for later, and only then", async () => {
  const { stripe, deps } = setup({ begin: { data: { ...started, saved_for_autopay: true, installment_id: "inst-1" } } });
  await createDuesCheckout(deps, { ...input, autopay: true });
  const session = stripe.requests.find((r) => r.path === "/v1/checkout/sessions")!;
  assertEquals(session.params["payment_intent_data[setup_future_usage]"], "off_session");
});

Deno.test("checkout: creates the Stripe customer once and remembers it; reuses it afterwards", async () => {
  const first = setup();
  await createDuesCheckout(first.deps, input);
  const created = first.stripe.requests.find((r) => r.path === "/v1/customers")!;
  assertEquals(created.headers["Idempotency-Key"], "cust_fam-1_test");
  assertEquals(first.admin.called("billing_set_customer")[0].args, { p_family: "fam-1", p_livemode: false, p_customer_id: "cus_1" });

  const second = setup({ tables: { ...tables, billing_customers: [{ family_id: "fam-1", livemode: false, stripe_customer_id: "cus_existing" }] } });
  await createDuesCheckout(second.deps, input);
  assertEquals(second.stripe.requests.some((r) => r.path === "/v1/customers"), false);
  assertEquals(second.stripe.requests.find((r) => r.path === "/v1/checkout/sessions")!.params["customer"], "cus_existing");
});

Deno.test("checkout: a double click reuses the open page instead of starting a second payment", async () => {
  const { stripe, deps } = setup({
    begin: { data: { ...started, existing: true, checkout_session_id: "cs_old" } },
    routes: { "GET /v1/checkout/sessions/cs_old": { id: "cs_old", status: "open", url: "https://checkout.stripe.com/c/pay/cs_old" } },
  });
  const result = await createDuesCheckout(deps, input);
  assertEquals(result.ok && result.kind === "hosted" && result.url, "https://checkout.stripe.com/c/pay/cs_old");
  assertEquals(stripe.requests.some((r) => r.method === "POST"), false);
});

Deno.test("checkout: a payment already clearing is explained, not duplicated", async () => {
  const { deps } = setup({ begin: { data: { ...started, existing: true, status: "processing", checkout_session_id: "cs_old" } } });
  const result = await createDuesCheckout(deps, input);
  assertEquals(!result.ok && result.status, 409);
  assertStringIncludes(!result.ok ? result.error : "", "1–4 business days");
});

Deno.test("checkout: an expired page is cleared and a fresh one is opened", async () => {
  let calls = 0;
  const admin = fakeAdmin({
    tables: tables as never,
    rpc: {
      billing_begin_payment: () => (++calls === 1 ? { data: { ...started, existing: true, checkout_session_id: "cs_old" } } : { data: { ...started, payment_id: "pay-2" } }),
      billing_attach_checkout: () => ({ data: null }), billing_set_customer: () => ({ data: null }), billing_cancel_payment: () => ({ data: null }),
    },
  });
  const stripe = fakeStripe({
    "GET /v1/checkout/sessions/cs_old": { id: "cs_old", status: "expired", url: null },
    "POST /v1/customers": { id: "cus_1" }, "POST /v1/checkout/sessions": { id: "cs_2", url: "https://checkout.stripe.com/c/pay/cs_2" },
  });
  const result = await createDuesCheckout({ admin: admin.client, stripe: stripe.stripe, config }, input);
  assertEquals(result.ok && result.paymentId, "pay-2");
  assertEquals(admin.called("billing_cancel_payment")[0].args.p_payment, "pay-1");
});

Deno.test("checkout: database refusals become plain messages (demo account, other household, nothing owed, payments off)", async () => {
  for (const [code, status, words] of [
    ["demo_account", 403, "demo"], ["not_allowed", 403, "household"], ["nothing_due", 409, "Nothing is owed"], ["online_payments_off", 409, "not turned on"],
  ] as const) {
    const { stripe, deps } = setup({ begin: { error: { message: code } } });
    const result = await createDuesCheckout(deps, input);
    assertEquals(!result.ok && result.status, status, code);
    assertStringIncludes(!result.ok ? result.error : "", words);
    assertEquals(stripe.requests.length, 0, "Stripe is never called");
  }
});

Deno.test("checkout: if Stripe cannot open the page the attempt is released so the family can try again", async () => {
  const { admin, deps } = setup({ routes: { "POST /v1/checkout/sessions": () => ({ status: 500, body: { error: { message: "boom" } } }) } });
  const result = await createDuesCheckout(deps, input);
  assertEquals(!result.ok && result.status, 502);
  assertEquals(admin.called("billing_cancel_payment")[0].args.p_payment, "pay-1");
});

Deno.test("checkout: on the website the form is embedded, with return_url and no redirect for cards", async () => {
  const { stripe, deps } = setup({ routes: { "POST /v1/checkout/sessions": { id: "cs_e", client_secret: "cs_e_secret_x", url: null } } });
  const result = await createDuesCheckout({ ...deps, config: embeddedConfig }, { ...input, embedded: true });
  assertEquals(result, { ok: true, kind: "embedded", clientSecret: "cs_e_secret_x", publishableKey: "pk_test_fake", paymentId: "pay-1" });
  const session = stripe.requests.find((r) => r.path === "/v1/checkout/sessions")!;
  assertEquals(session.params["ui_mode"], "embedded");
  assertEquals(session.params["redirect_on_completion"], "if_required");
  assertStringIncludes(session.params["return_url"], "/family-village/dues?checkout=success");
  assertEquals(session.params["success_url"], undefined, "embedded sessions take return_url, not success_url");
  assertEquals(session.params["line_items[0][price_data][unit_amount]"], "60000", "the amount still comes from the database");
});

Deno.test("checkout: without a publishable key the app falls back to Stripe's own page", async () => {
  const { stripe, deps } = setup();
  const result = await createDuesCheckout(deps, { ...input, embedded: true });
  assertEquals(result.ok && result.kind, "hosted");
  assertEquals(stripe.requests.find((r) => r.path === "/v1/checkout/sessions")!.params["ui_mode"], undefined);
});

Deno.test("checkout: an open embedded page is resumed; one started the other way is closed and replaced", async () => {
  const resumed = setup({
    begin: { data: { ...started, existing: true, checkout_session_id: "cs_old" } },
    routes: { "GET /v1/checkout/sessions/cs_old": { id: "cs_old", status: "open", ui_mode: "embedded", client_secret: "cs_old_secret_y" } },
  });
  const r1 = await createDuesCheckout({ ...resumed.deps, config: embeddedConfig }, { ...input, embedded: true });
  assertEquals(r1.ok && r1.kind === "embedded" && r1.clientSecret, "cs_old_secret_y");

  let calls = 0;
  const admin = fakeAdmin({
    tables: tables as never,
    rpc: {
      billing_begin_payment: () => (++calls === 1 ? { data: { ...started, existing: true, checkout_session_id: "cs_old" } } : { data: { ...started, payment_id: "pay-2" } }),
      billing_attach_checkout: () => ({ data: null }), billing_set_customer: () => ({ data: null }), billing_cancel_payment: () => ({ data: null }),
    },
  });
  const stripe = fakeStripe({
    "GET /v1/checkout/sessions/cs_old": { id: "cs_old", status: "open", ui_mode: "hosted", url: "https://checkout.stripe.com/c/pay/cs_old" },
    "POST /v1/checkout/sessions/cs_old/expire": { id: "cs_old", status: "expired" },
    "POST /v1/customers": { id: "cus_1" }, "POST /v1/checkout/sessions": { id: "cs_new", client_secret: "cs_new_secret", url: null },
  });
  const r2 = await createDuesCheckout({ admin: admin.client, stripe: stripe.stripe, config: embeddedConfig }, { ...input, embedded: true });
  assertEquals(r2.ok && r2.paymentId, "pay-2");
  assertEquals(stripe.requests.some((r) => r.path === "/v1/checkout/sessions/cs_old/expire"), true);
  assertEquals(admin.called("billing_cancel_payment")[0].args.p_payment, "pay-1");
});
