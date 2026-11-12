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
  /** Show Stripe's form inside the page. Falls back to Stripe's own page when no publishable key is set. */
  embedded?: boolean;
  /** The iPhone or Android app is asking: return a PaymentIntent for the native payment sheet (Apple Pay / Google Pay). */
  native?: boolean;
};

export type CheckoutResult =
  | { ok: true; kind: "hosted"; url: string; paymentId: string }
  | { ok: true; kind: "embedded"; clientSecret: string; publishableKey: string; paymentId: string }
  | { ok: true; kind: "native"; paymentIntentClientSecret: string; publishableKey: string; customerId: string; merchantDisplayName: string; amountCents: number; paymentId: string }
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
  const embedded = Boolean(input.embedded) && Boolean(deps.config.publishableKey);
  const native = Boolean(input.native) && Boolean(deps.config.publishableKey);

  let attempt = await begin(admin, input);
  for (let round = 0; round < 2; round++) {
    if (attempt.error) {
      const code = Object.keys(BEGIN_ERRORS).find((key) => attempt.error!.message.includes(key));
      if (code) return { ok: false, ...BEGIN_ERRORS[code], code };
      throw new Error(`billing_begin_payment: ${attempt.error.message}`);
    }
    const started = attempt.data as any;

    if (native) {
      const outcome = await nativeFlow(deps, input, started);
      if (outcome !== "retry") return outcome;
      attempt = await begin(admin, input);
      continue;
    }

    if (!started.existing) return await openSession(deps, input, started, origin, embedded);

    // Something is already in flight for this charge.
    if (started.status === "processing") {
      return { ok: false, status: 409, code: "processing", error: "A payment is already being processed. Bank transfers take 1–4 business days to clear." };
    }
    if (!started.checkout_session_id) {
      return { ok: false, status: 409, code: "starting", error: "A payment is already starting. Give it a moment, then try again." };
    }
    const session = await stripe.get(`/v1/checkout/sessions/${started.checkout_session_id}`);
    const sameKind = (session.ui_mode === "embedded") === embedded;
    if (session.status === "open" && sameKind) {
      if (embedded && session.client_secret) return { ok: true, kind: "embedded", clientSecret: session.client_secret, publishableKey: deps.config.publishableKey!, paymentId: started.payment_id };
      if (!embedded && session.url) return { ok: true, kind: "hosted", url: session.url, paymentId: started.payment_id };
    }
    // Open, but started the other way (say on the website, now in the app): close it so there is one page.
    if (session.status === "open") {
      await stripe.post(`/v1/checkout/sessions/${started.checkout_session_id}/expire`, {}).catch(() => undefined);
    }
    if (session.status === "complete") {
      return { ok: false, status: 409, code: "processing", error: "Your payment was submitted and is being confirmed. Check back shortly." };
    }
    // Expired or abandoned: clear it and start fresh.
    await admin.rpc("billing_cancel_payment", { p_payment: started.payment_id, p_reason: "The checkout page expired." });
    attempt = await begin(admin, input);
  }
  return { ok: false, status: 409, code: "busy", error: "Could not start a payment right now. Please try again." };
}

/**
 * Stripe's own checkout page, dressed as Veritas Village (the brand tokens in app/globals.css): cream page,
 * navy button, Inter, rounded corners. Stripe offers only preset fonts and no Playfair, so the serif is left
 * to the site. The logo and icon show on the full hosted page only; the embedded form ignores them.
 */
export function checkoutBranding(origin: string, embedded: boolean) {
  return {
    display_name: "Veritas Village",
    background_color: "#faf7f1",
    button_color: "#0b2a3d",
    font_family: "inter",
    border_style: "rounded",
    ...(embedded ? {} : {
      logo: { type: "url", url: `${origin}/brand/lockup-horizontal-navy.png` },
      icon: { type: "url", url: `${origin}/brand/icon-512.png` },
    }),
  };
}

async function openSession(deps: Deps, input: CheckoutInput, started: any, origin: string, embedded: boolean): Promise<CheckoutResult> {
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
      branding_settings: checkoutBranding(origin, embedded),
      ...(embedded
        ? { ui_mode: "embedded", return_url: `${origin}/family-village/dues?checkout=success`, redirect_on_completion: "if_required" }
        : { success_url: `${origin}/family-village/dues?checkout=success`, cancel_url: `${origin}/family-village/dues?checkout=canceled` }),
      expires_at: (deps.nowSeconds ?? Math.floor(Date.now() / 1000)) + 31 * 60,
    }, paymentId);

    await admin.rpc("billing_attach_checkout", { p_payment: paymentId, p_session_id: session.id });
    if (embedded) return { ok: true, kind: "embedded", clientSecret: session.client_secret, publishableKey: deps.config.publishableKey!, paymentId };
    return { ok: true, kind: "hosted", url: session.url, paymentId };
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

const IN_PROGRESS = "A payment is already being processed. Bank transfers take 1–4 business days to clear.";

/**
 * The native app pays with a PaymentIntent and Stripe's native payment sheet, which
 * is what lets Apple Pay and Google Pay appear inside the app. The webhook handles
 * a PaymentIntent exactly as it handles one made by Checkout, so nothing else changes.
 */
async function nativeFlow(deps: Deps, input: CheckoutInput, started: any): Promise<CheckoutResult | "retry"> {
  const { admin, stripe, config } = deps;
  const paymentId = started.payment_id as string;
  const publishableKey = config.publishableKey!;

  if (started.existing) {
    if (started.status === "processing") return { ok: false, status: 409, code: "processing", error: IN_PROGRESS };
    const { data: row } = await admin.from("dues_payments").select("stripe_payment_intent_id").eq("id", paymentId).maybeSingle();
    if (row?.stripe_payment_intent_id) {
      const pi = await stripe.get(`/v1/payment_intents/${row.stripe_payment_intent_id}`);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status) && pi.client_secret) {
        return { ok: true, kind: "native", paymentIntentClientSecret: pi.client_secret, publishableKey, customerId: pi.customer, merchantDisplayName: "Veritas Village", amountCents: started.amount_cents, paymentId };
      }
      if (pi.status === "canceled") {
        await admin.rpc("billing_cancel_payment", { p_payment: paymentId, p_reason: "The payment was canceled." });
        return "retry";
      }
      return { ok: false, status: 409, code: "processing", error: IN_PROGRESS };
    }
    if (started.checkout_session_id) {
      // Opened as a Checkout page earlier (say on the website): close it and start the native way.
      await stripe.post(`/v1/checkout/sessions/${started.checkout_session_id}/expire`, {}).catch(() => undefined);
      await admin.rpc("billing_cancel_payment", { p_payment: paymentId, p_reason: "Switched to the app's payment sheet." });
      return "retry";
    }
    return { ok: false, status: 409, code: "starting", error: "A payment is already starting. Give it a moment, then try again." };
  }

  try {
    const { data: charge } = await admin.from("dues_charges")
      .select("id,family_id,families(display_name),requirements(title),school_years(label)").eq("id", input.chargeId).single();
    const familyName = (charge as any)?.families?.display_name ?? "Household";
    const title = (charge as any)?.requirements?.title ?? "Dues";
    const year = (charge as any)?.school_years?.label ?? "";
    const customerId = await ensureCustomer(deps, started.family_id, familyName, input.userEmail);

    const pi = await stripe.post("/v1/payment_intents", {
      amount: started.amount_cents,
      currency: "usd",
      customer: customerId,
      // Bank transfer first, then card. Apple Pay and Google Pay are cards in the payment sheet.
      payment_method_types: ["us_bank_account", "card"],
      description: `${title}${year ? ` (${year})` : ""} — ${familyName}`,
      metadata: { payment_id: paymentId, charge_id: input.chargeId, family_id: started.family_id, installment_id: started.installment_id ?? "", source: "portal" },
      ...(started.saved_for_autopay ? { setup_future_usage: "off_session" } : {}),
      payment_method_options: { us_bank_account: { verification_method: "automatic", financial_connections: { permissions: ["payment_method"] } } },
    }, paymentId);

    // Remember which PaymentIntent belongs to this attempt (a pending update changes only the ids).
    const attached = await admin.rpc("billing_apply_payment_update", { p_payment: paymentId, p_status: "pending", p_event_id: null, p_fields: { payment_intent_id: pi.id } });
    if (attached.error) throw new Error(`billing_apply_payment_update: ${attached.error.message}`);
    return { ok: true, kind: "native", paymentIntentClientSecret: pi.client_secret, publishableKey, customerId, merchantDisplayName: "Veritas Village", amountCents: started.amount_cents, paymentId };
  } catch (error) {
    await admin.rpc("billing_cancel_payment", { p_payment: paymentId, p_reason: "Could not start the payment." });
    if (error instanceof StripeError) return { ok: false, status: 502, code: "stripe", error: "The payment could not be started. Please try again in a few minutes." };
    throw error;
  }
}
