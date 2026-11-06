import { loadStripeConfig, StripeClient, type StripeConfig } from "./stripe.ts";
import type { AdminClient } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

/**
 * Before someone's account is erased: if they are the last adult in a household
 * that has a Stripe customer, remove their name, email and saved payment method
 * from Stripe and from the saved-method labels here. The household's payment
 * records stay (the co-op must keep them); the person no longer identifies them.
 *
 * Best effort and never blocks the erasure. When Stripe cannot be reached or is
 * not configured, the customer ids are written to the audit log so an
 * administrator can finish the job by hand in the Stripe dashboard.
 */
export async function scrubBillingForErasure(
  admin: AdminClient, userId: string, options: { config?: StripeConfig; makeStripe?: (key: string) => StripeClient } = {},
): Promise<{ households: number; scrubbed: number; pending: string[] }> {
  const { data: mine } = await admin.from("family_members").select("family_id").eq("user_id", userId);
  const familyIds = [...new Set(((mine ?? []) as any[]).map((row) => row.family_id as string))];
  if (!familyIds.length) return { households: 0, scrubbed: 0, pending: [] };

  const { data: members } = await admin.from("family_members").select("family_id,user_id").in("family_id", familyIds);
  const soleAdultOf = familyIds.filter((id) => !((members ?? []) as any[]).some((m) => m.family_id === id && m.user_id !== userId));
  if (!soleAdultOf.length) return { households: 0, scrubbed: 0, pending: [] };

  const { data: customers } = await admin.from("billing_customers")
    .select("id,family_id,livemode,stripe_customer_id,stripe_payment_method_id").in("family_id", soleAdultOf);
  const rows = (customers ?? []) as any[];
  if (!rows.length) return { households: soleAdultOf.length, scrubbed: 0, pending: [] };

  const config = options.config ?? await loadStripeConfig(admin);
  const makeStripe = options.makeStripe ?? ((key: string) => new StripeClient(key));
  const pending: string[] = [];
  let scrubbed = 0;

  for (const row of rows) {
    // A customer can only be edited with the key for its own mode.
    let done = false;
    if (config.ok && config.livemode === row.livemode) {
      const stripe = makeStripe(config.secretKey);
      try {
        if (row.stripe_payment_method_id) {
          await stripe.post(`/v1/payment_methods/${row.stripe_payment_method_id}/detach`, {}).catch(() => undefined);
        }
        // An empty string clears a field in Stripe.
        await stripe.post(`/v1/customers/${row.stripe_customer_id}`, { name: "Former household", email: "", phone: "", description: "Account erased at the member's request" });
        done = true;
      } catch { /* fall through to pending */ }
    }
    if (done) scrubbed++; else pending.push(row.stripe_customer_id);
    await admin.from("billing_customers").update({
      autopay: false, stripe_payment_method_id: null, default_pm_type: null, default_pm_brand: null, default_pm_last4: null, default_pm_bank_name: null,
    }).eq("id", row.id);
  }

  if (pending.length) {
    await admin.from("audit_log").insert({
      actor_user_id: null, action: "stripe_customer_scrub_pending", subject_type: "profile", subject_id: userId,
      detail: { stripe_customers: pending, note: "Remove the name, email and saved payment method from these customers in the Stripe dashboard." },
    });
  }
  return { households: soleAdultOf.length, scrubbed, pending };
}
