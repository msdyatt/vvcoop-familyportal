/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { scrubBillingForErasure } from "./billing-erasure.ts";
import { fakeAdmin, fakeStripe } from "./stripe-fakes.ts";

const tables = {
  family_members: [
    { family_id: "f1", user_id: "u1" },                       // sole adult
    { family_id: "f2", user_id: "u1" }, { family_id: "f2", user_id: "u2" },   // shared with another adult
  ],
  billing_customers: [
    { id: "b1", family_id: "f1", livemode: false, stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1" },
    { id: "b2", family_id: "f2", livemode: false, stripe_customer_id: "cus_2", stripe_payment_method_id: "pm_2" },
  ],
};
const config = { ok: true as const, provider: "stripe_test" as const, livemode: false, secretKey: "sk_test_x", publishableKey: null };

Deno.test("erasure: a household's last adult is removed from Stripe; a shared household is left alone", async () => {
  const admin = fakeAdmin({ tables: tables as never });
  const stripe = fakeStripe({ "POST /v1/payment_methods/pm_1/detach": { id: "pm_1" }, "POST /v1/customers/cus_1": { id: "cus_1" } });
  const result = await scrubBillingForErasure(admin.client, "u1", { config, makeStripe: () => stripe.stripe });
  assertEquals(result, { households: 1, scrubbed: 1, pending: [] });
  const customer = stripe.requests.find((r) => r.path === "/v1/customers/cus_1")!;
  assertEquals([customer.params.name, customer.params.email], ["Former household", ""]);
  assertEquals(stripe.requests.some((r) => r.path.includes("cus_2") || r.path.includes("pm_2")), false);
  assertEquals(admin.updates[0].values.autopay, false);
  assertEquals(admin.updates[0].values.default_pm_last4, null);
});

Deno.test("erasure: when Stripe cannot be reached the customer ids are logged for an administrator and the erasure still proceeds", async () => {
  const inserted: unknown[] = [];
  const admin = fakeAdmin({ tables: tables as never });
  const original = admin.client as unknown as { from: (t: string) => unknown };
  const from = original.from.bind(original);
  original.from = (table: string) => table === "audit_log" ? { insert: (row: unknown) => { inserted.push(row); return Promise.resolve({ error: null }); } } : from(table);
  const result = await scrubBillingForErasure(admin.client, "u1", { config: { ok: false, code: "no_key", provider: "stripe_test", message: "x" } });
  assertEquals(result.pending, ["cus_1"]);
  assertEquals((inserted[0] as { action: string }).action, "stripe_customer_scrub_pending");
});

Deno.test("erasure: someone with no household or no Stripe customer needs nothing", async () => {
  const none = fakeAdmin({ tables: { family_members: [], billing_customers: [] } });
  assertEquals((await scrubBillingForErasure(none.client, "u9", { config })).households, 0);
  const noCustomer = fakeAdmin({ tables: { family_members: [{ family_id: "f1", user_id: "u1" }], billing_customers: [] } });
  assertEquals((await scrubBillingForErasure(noCustomer.client, "u1", { config })).scrubbed, 0);
});
