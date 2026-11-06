/* eslint-disable @typescript-eslint/no-explicit-any */
import { safeEqual } from "./crypto.ts";
import { readVaultSecret } from "./resend.ts";
import type { AdminClient } from "./types.ts";

/**
 * A small Stripe client over fetch -- no SDK, so every call the app can make is
 * visible in one place and a test can hand in a fake `fetch`.
 *
 * Card and bank details never pass through here. People enter them in Stripe's
 * own Checkout page; this code only ever sees ids, brands and last-four digits.
 */

/** Pinned so a Stripe-side default change cannot reshape responses under us. */
export const STRIPE_API_VERSION = "2025-09-30.clover";

export type DuesProvider = "off" | "stripe_test" | "stripe_live";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Stripe wants nested form fields: a[b]=1, a[0]=x. */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(`${key}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) add(`${key}[${inner}]`, innerValue);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return pairs.join("&");
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly type: string | null,
    // deno-lint-ignore no-explicit-any
    readonly raw: any,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl = "https://api.stripe.com",
  ) {}

  // deno-lint-ignore no-explicit-any
  async request<T = any>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, options: { idempotencyKey?: string } = {}): Promise<T> {
    const body = encodeForm(params);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
    };
    let url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers };
    if (method === "GET") {
      if (body) url += `?${body}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      init.body = body;
    }
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    // deno-lint-ignore no-explicit-any
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    if (!response.ok) {
      const err = parsed?.error ?? {};
      throw new StripeError(err.message ?? `Stripe returned ${response.status}`, response.status, err.code ?? null, err.type ?? null, parsed);
    }
    return parsed as T;
  }

  // deno-lint-ignore no-explicit-any
  get<T = any>(path: string, params: Record<string, unknown> = {}) { return this.request<T>("GET", path, params); }
  // deno-lint-ignore no-explicit-any
  post<T = any>(path: string, params: Record<string, unknown> = {}, idempotencyKey?: string) { return this.request<T>("POST", path, params, { idempotencyKey }); }
}

// --- configuration -------------------------------------------------------------------

export type StripeConfig =
  | { ok: true; provider: "stripe_test" | "stripe_live"; livemode: boolean; secretKey: string }
  | { ok: false; code: "off" | "no_key" | "wrong_key"; provider: DuesProvider; message: string };

const SECRET_NAMES = { stripe_test: "STRIPE_SECRET_KEY_TEST", stripe_live: "STRIPE_SECRET_KEY_LIVE" } as const;
const WEBHOOK_NAMES = { stripe_test: "STRIPE_WEBHOOK_SECRET_TEST", stripe_live: "STRIPE_WEBHOOK_SECRET_LIVE" } as const;

export async function readProvider(admin: AdminClient): Promise<DuesProvider> {
  const { data } = await admin.from("billing_settings").select("provider").eq("id", "dues").maybeSingle();
  const provider = data?.provider as string | undefined;
  return provider === "stripe_test" || provider === "stripe_live" ? provider : "off";
}

/**
 * The key for the mode the co-op has chosen, read from Vault (never an env
 * variable, never the repo). A key that does not match the mode is refused, so a
 * live key can never be used while the app believes it is in test mode.
 */
export async function loadStripeConfig(admin: AdminClient): Promise<StripeConfig> {
  const provider = await readProvider(admin);
  if (provider === "off") {
    return { ok: false, code: "off", provider, message: "Online dues payments are switched off. Turn on test mode in Admin → Dues → Settings." };
  }
  const name = SECRET_NAMES[provider];
  const secretKey = (await readVaultSecret(admin, name))?.trim();
  if (!secretKey) {
    return {
      ok: false, code: "no_key", provider,
      message: `Stripe is not connected yet: the ${name} secret is not in Supabase Vault. Follow docs/stripe-setup-checklist.md, then try again.`,
    };
  }
  const expected = provider === "stripe_live" ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (!expected.test(secretKey)) {
    return {
      ok: false, code: "wrong_key", provider,
      message: `The ${name} secret does not look like a ${provider === "stripe_live" ? "live" : "test"}-mode key. Nothing was sent to Stripe.`,
    };
  }
  return { ok: true, provider, livemode: provider === "stripe_live", secretKey };
}

export async function loadWebhookSecrets(admin: AdminClient): Promise<{ test: string | null; live: string | null }> {
  const [test, live] = await Promise.all([
    readVaultSecret(admin, WEBHOOK_NAMES.stripe_test), readVaultSecret(admin, WEBHOOK_NAMES.stripe_live),
  ]);
  return { test: test?.trim() || null, live: live?.trim() || null };
}

// --- webhook signatures -----------------------------------------------------------------

function toHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stripe signs `<timestamp>.<raw body>` with HMAC-SHA256 and sends
 * `Stripe-Signature: t=...,v1=...`. The raw body must be exactly what was
 * received. Stale timestamps are refused so a captured request cannot be replayed.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t) || !signatures.length) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return signatures.some((candidate) => safeEqual(candidate, expected));
}

/** Signs a payload the way Stripe does. Only tests use it. */
export async function signStripePayload(rawBody: string, secret: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  return `t=${timestamp},v1=${signature}`;
}

// --- reading Stripe's objects ---------------------------------------------------------------

export type PaymentFields = {
  method: "card" | "us_bank_account" | null;
  wallet: "apple_pay" | "google_pay" | "link" | "other" | null;
  brand: string | null;
  last4: string | null;
  bank_name: string | null;
  receipt_url: string | null;
  charge_id: string | null;
};

/** Display facts about how a charge was paid: brand, last four, bank name, wallet. */
// deno-lint-ignore no-explicit-any
export function describeCharge(charge: any): PaymentFields {
  const details = charge?.payment_method_details ?? {};
  const type = details.type as string | undefined;
  const out: PaymentFields = { method: null, wallet: null, brand: null, last4: null, bank_name: null, receipt_url: charge?.receipt_url ?? null, charge_id: charge?.id ?? null };
  if (type === "card") {
    out.method = "card";
    out.brand = details.card?.brand ?? null;
    out.last4 = details.card?.last4 ?? null;
    const wallet = details.card?.wallet?.type as string | undefined;
    if (wallet) out.wallet = wallet === "apple_pay" || wallet === "google_pay" || wallet === "link" ? wallet : "other";
  } else if (type === "us_bank_account") {
    out.method = "us_bank_account";
    out.brand = "us_bank_account";
    out.last4 = details.us_bank_account?.last4 ?? null;
    out.bank_name = details.us_bank_account?.bank_name ?? null;
  }
  if (out.last4 && !/^[0-9]{4}$/.test(out.last4)) out.last4 = null;
  return out;
}

/** Plain-language reasons for the failures families most often meet. */
export function friendlyFailure(code: string | null | undefined, fallback: string | null | undefined): string {
  switch (code) {
    case "insufficient_funds": return "Your bank reported insufficient funds.";
    case "account_closed": return "That bank account is closed.";
    case "no_account": case "invalid_account_number": return "That bank account could not be found.";
    case "debit_not_authorized": return "The bank says this debit was not authorized.";
    case "card_declined": case "generic_decline": return "Your card was declined.";
    case "expired_card": return "That card has expired.";
    case "incorrect_cvc": return "The card security code was incorrect.";
    case "authentication_required": return "Your bank needs you to confirm this payment. Please pay again from Family Village.";
    default: return (fallback ?? "").slice(0, 200) || "The payment did not go through.";
  }
}
