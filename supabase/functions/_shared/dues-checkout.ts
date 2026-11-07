import { StripeError, type StripeClient, type StripeConfig } from "./stripe.ts";
import type { AdminClient } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

export const APP_ORIGIN = "https://family.veritasvillage.org";

export type CheckoutInput = {
  userId: string;
  userEmail: string | null;
  chargeId: string;
  /** Pay the whole balance now instead of the next installment. */
  payAll?: boolean;
  /** The household agreed to automatic monthly collection with the method it is about to enter. */
  autopay?: boolean;
};

export type CheckoutResult =
  | { ok: true; url: string; paymentId: string }
  | { ok: false; status: number; error: string; code: string };

type Deps = { admin: AdminClient; stripe: StripeClient; config: Extract<StripeConfig, { ok: true }>; origin?: string; nowSeconds?: number };

const BEGIN_ERRORS: Record<string, { status: number; error: string }> = {
  online_payments_off: { status: 409, error: "Online payments are not turned on yet. Please check back soon." },
  charge_not_found: { status: 404, error: "We could not find that charge." },
  not_allowed: { status: 403, error: "That charge does not belong to your household." },
  demo_account: { status: 403, error: "Payments are turned off in demo accounts." },
  charge_closed: { status: 409, error: "That charge is closed. Nothing is owed on it." },
  nothing_due: { status: 409, error: "Nothing is owed on this charge." },
};

function begin(admin: AdminClient, input: CheckoutInput) {
  return admin.rpc("billing_begin_payment", {
    p_user: input.userId, p_charge: input.chargeId, p_pay_all: Boolean(input.payAll), p_autopay: Boolean(input.autopay),
  });
}

/**
 * Starts (or resumes) a payment for a household.
 *
 * The amount is decided in the database. The page asks to pay a charge; it never
 * says how much. The payment row exists, pending, before Stripe is called, and
 * its id is the Idempotency-Key, so a retried request cannot create a second
 * session and a double click reuses the first.
 */
export async function createDuesCheckout(deps: Deps, input: CheckoutInput): Promise<CheckoutResult> {
  const { admin, stripe } = deps;
  const origin = deps.origin ?? APP_ORIGIN;

  let attempt = await begin(admin, input);
  for (let round = 0; round < 2; round++) {
    if (attempt.error) {
      const code = Object.keys(BEGIN_ERRORS).find((key) => attempt.error!.message.includes(key));
      if (code) return { ok: false, ...BEGIN_ERRORS[code], code };
      throw new Error(`billing_begin_payment: ${attempt.error.message}`);
    }
    const started = attempt.data as any;

    if (!started.existing) return await openSession(deps, input, started, origin);

    // Something is already in flight for this charge.
    if (started.status === "processing") {
      return { ok: false, status: 409, code: "processing", error: "A payment is already being processed. Bank transfers take 1–4 business days to clear." };
    }
    if (!started.checkout_session_id) {
      return { ok: false, status: 409, code: "starting", error: "A payment is already starting. Give it a moment, then try again." };
    }
    const session = await stripe.get(`/v1/checkout/sessions/${started.checkout_session_id}`);
    if (session.status === "open" && session.url) return { ok: true, url: session.url, paymentId: started.payment_id };
    if (session.status === "complete") {
      return { ok: false, status: 409, code: "processing", error: "Your payment was submitted and is being confirmed. Check back shortly." };
    }
    // Expired or abandoned: clear it and start fresh.
    await admin.rpc("billing_cancel_payment", { p_payment: started.payment_id, p_reason: "The checkout page expired." });
    attempt = await begin(admin, input);
  }
  return { ok: false, status: 409, code: "busy", error: "Could not start a payment right now. Please try again." };
}

async function openSession(deps: Deps, input: CheckoutInput, started: any, origin: string): Promise<CheckoutResult> {
  const { admin, stripe } = deps;
  const paymentId = started.payment_id as string;
  try {
    const { data: charge } = await admin.from("dues_charges")
      .select("id,family_id,families(display_name),requirements(title),school_years(label)")
      .eq("id", input.chargeId).single();
    const familyName = (charge as any)?.families?.display_name ?? "Household";
    const title = (charge as any)?.requirements?.title ?? "Dues";
    const year = (charge as any)?.school_years?.label ?? "";

    const customerId = await ensureCustomer(deps, started.family_id, familyName, input.userEmail);
    const saveMethod = Boolean(started.saved_for_autopay);
    const description = `${title}${year ? ` (${year})` : ""} — ${familyName}`;
    const metadata = {
      payment_id: paymentId, charge_id: input.chargeId, family_id: started.family_id,
      installment_id: started.installment_id ?? "", source: "portal",
    };

    const session = await stripe.post("/v1/checkout/sessions", {
      mode: "payment",
      customer: customerId,
      // Families pay exactly the dues amount in dollars; no currency conversion.
      adaptive_pricing: { enabled: false },
      client_reference_id: paymentId,
      // Bank transfer first: it is the cheapest way for the co-op to be paid.
      // Apple Pay and Google Pay appear under the card option when the device supports them.
      payment_method_types: ["us_bank_account", "card"],
      line_items: [{
        quantity: 1,
        price_data: { currency: "usd", unit_amount: started.amount_cents, product_data: { name: `${title}${year ? ` ${year}` : ""}`, description: `Veritas Village — ${familyName}` } },
      }],
      payment_intent_data: { description, metadata, ...(saveMethod ? { setup_future_usage: "off_session" } : {}) },
      metadata,
      payment_method_options: {
        us_bank_account: { verification_method: "automatic", financial_connections: { permissions: ["payment_method"] } },
      },
      success_url: `${origin}/family-village/dues?checkout=success`,
      cancel_url: `${origin}/family-village/dues?checkout=canceled`,
      expires_at: (deps.nowSeconds ?? Math.floor(Date.now() / 1000)) + 31 * 60,
    }, paymentId);

    await admin.rpc("billing_attach_checkout", { p_payment: paymentId, p_session_id: session.id });
    return { ok: true, url: session.url, paymentId };
  } catch (error) {
    // Nothing reached Stripe that could charge anyone; free the charge for another try.
    await admin.rpc("billing_cancel_payment", { p_payment: paymentId, p_reason: "Could not open the checkout page." });
    if (error instanceof StripeError) {
      return { ok: false, status: 502, code: "stripe", error: "The payment page could not be opened. Please try again in a few minutes." };
    }
    throw error;
  }
}

async function ensureCustomer(deps: Deps, familyId: string, familyName: string, email: string | null): Promise<string> {
  const { admin, stripe, config } = deps;
  const { data } = await admin.from("billing_customers").select("stripe_customer_id").eq("family_id", familyId).eq("livemode", config.livemode).maybeSingle();
  if (data?.stripe_customer_id) return data.stripe_customer_id;
  const customer = await stripe.post("/v1/customers", {
    name: familyName, email: email ?? undefined, metadata: { family_id: familyId },
  }, `cust_${familyId}_${config.livemode ? "live" : "test"}`);
  await admin.rpc("billing_set_customer", { p_family: familyId, p_livemode: config.livemode, p_customer_id: customer.id });
  return customer.id;
}
