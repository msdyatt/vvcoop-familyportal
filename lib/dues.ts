/**
 * Dues payments, as the browser sees them. All money is integer cents; the
 * database works out every total (see supabase/migrations/*_stripe_dues_schema.sql)
 * and this file only names, formats and groups what it returns. It imports
 * nothing, so the edge-function test job can run its tests; the calls that
 * reach the network are in dues-api.ts.
 */

export type BillingProvider = "off" | "stripe_test" | "stripe_live";
export type ChargeStatus = "open" | "partially_paid" | "paid" | "void" | "uncollectible";
export type PaymentStatus = "pending" | "processing" | "succeeded" | "failed" | "canceled";
export type PaymentMethod = "card" | "us_bank_account" | "cash" | "check" | "crowded" | "other";

export type BillingSettings = {
  provider: BillingProvider;
  reminder_days_before: number;
  retry_after_days: number;
  max_attempts: number;
  receipt_org_name: string;
  receipt_ein: string | null;
  receipt_address: string | null;
  receipt_note: string | null;
};

export type DuesCharge = {
  id: string;
  requirement_id: string;
  family_id: string;
  school_year_id: string;
  subtotal_cents: number;
  discount_total_cents: number;
  adjustment_total_cents: number;
  amount_due_cents: number;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  balance_cents: number;
  status: ChargeStatus;
  void_reason: string | null;
  disputed_at: string | null;
  family_name: string;
  requirement_title: string;
  due_on: string | null;
};

export type DiscountLine = { id: string; charge_id: string; label: string; amount_cents: number };
export type Adjustment = { id: string; charge_id: string; amount_cents: number; reason: string; memo: string; reverses_adjustment_id: string | null; created_at: string };
export type Plan = { id: string; charge_id: string; kind: "full" | "monthly" | "custom"; status: "active" | "completed" | "cancelled"; paid_before_cents: number };
export type Installment = { id: string; plan_id: string; charge_id: string; seq: number; due_on: string; amount_cents: number; status: "scheduled" | "paid" | "cancelled"; paid_at: string | null; attempts: number; needs_attention: boolean };
export type Payment = {
  id: string; charge_id: string | null; family_id: string; installment_id: string | null; direction: "charge" | "refund";
  amount_cents: number; method: PaymentMethod | null; wallet: string | null; brand: string | null; last4: string | null; bank_name: string | null;
  status: PaymentStatus; source: string; livemode: boolean; receipt_no: number | null; failure_message: string | null;
  refunds_payment_id: string | null; reason: string | null; note: string | null; occurred_at: string | null; created_at: string;
};
export type RequirementOptions = { requirement_id: string; monthly_enabled: boolean; monthly_count: number; monthly_first_due_on: string | null };
export type SavedMethod = { default_pm_type: string | null; default_pm_brand: string | null; default_pm_last4: string | null; default_pm_bank_name: string | null; autopay: boolean };

export const CHARGE_COLUMNS = "id,requirement_id,family_id,school_year_id,subtotal_cents,discount_total_cents,adjustment_total_cents,amount_due_cents,amount_paid_cents,amount_refunded_cents,balance_cents,status,void_reason,disputed_at,family_name,requirement_title,due_on";
export const PAYMENT_COLUMNS = "id,charge_id,family_id,installment_id,direction,amount_cents,method,wallet,brand,last4,bank_name,status,source,livemode,receipt_no,failure_message,refunds_payment_id,reason,note,occurred_at,created_at";

// --- money and dates -----------------------------------------------------------------

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Dollars typed by a person ("1,250.5") to cents; null if it is not an amount. */
export function parseDollars(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Date-only values (due dates) are pinned to UTC for the same reason as
 * lib/compliance.ts: a date like 2026-09-15 would otherwise render a day early in
 * Central Time. Timestamps (when a payment cleared) are shown in Central.
 */
export function formatDueDate(value: string): string {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatWhen(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

export function todayIso(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// --- wording -----------------------------------------------------------------------------

const BRANDS: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay" };

/** "Visa ••4242 · Apple Pay", "Bank ••6789", "Cash". */
export function methodLabel(p: Pick<Payment, "method" | "wallet" | "brand" | "last4" | "bank_name">): string {
  const wallet = p.wallet === "apple_pay" ? " · Apple Pay" : p.wallet === "google_pay" ? " · Google Pay" : "";
  switch (p.method) {
    case "card": return `${BRANDS[p.brand ?? ""] ?? "Card"}${p.last4 ? ` ••${p.last4}` : ""}${wallet}`;
    case "us_bank_account": return `Bank ••${p.last4 ?? "····"}${p.bank_name ? ` (${p.bank_name})` : ""}`;
    case "cash": return "Cash";
    case "check": return "Check";
    case "crowded": return "Crowded (before online payments)";
    case "other": return "Other";
    default: return "—";
  }
}

export function savedMethodLabel(m: SavedMethod | null): string | null {
  if (!m || !m.default_pm_type) return null;
  return methodLabel({ method: m.default_pm_type as PaymentMethod, wallet: null, brand: m.default_pm_brand, last4: m.default_pm_last4, bank_name: m.default_pm_bank_name });
}

/** What the history shows for one row. Refunds are their own rows; the original stays "Paid". */
export function paymentStatusLabel(p: Pick<Payment, "status" | "direction">): { text: string; tone: "complete" | "pending" | "outstanding" | "waived" } {
  if (p.direction === "refund") {
    return p.status === "succeeded" ? { text: "Refunded", tone: "waived" }
      : p.status === "failed" || p.status === "canceled" ? { text: "Refund failed", tone: "outstanding" }
      : { text: "Refund pending", tone: "pending" };
  }
  switch (p.status) {
    case "succeeded": return { text: "Paid", tone: "complete" };
    case "processing": return { text: "Processing", tone: "pending" };
    case "pending": return { text: "Not completed", tone: "pending" };
    case "failed": return { text: "Failed", tone: "outstanding" };
    case "canceled": return { text: "Canceled", tone: "waived" };
  }
}

export type InstallmentView = Installment & { display: "paid" | "overdue" | "due" | "scheduled"; label: string };

/** Paid, overdue (date passed), due (the next one to pay), or scheduled (later). */
export function describeInstallments(installments: Installment[], today = todayIso()): InstallmentView[] {
  const live = installments.filter((i) => i.status !== "cancelled").sort((a, b) => a.seq - b.seq);
  const nextUnpaid = live.find((i) => i.status === "scheduled");
  return live.map((i) => {
    if (i.status === "paid") return { ...i, display: "paid", label: "Paid" };
    if (i.due_on.slice(0, 10) < today) return { ...i, display: "overdue", label: "Past due" };
    if (i === nextUnpaid) return { ...i, display: "due", label: "Next" };
    return { ...i, display: "scheduled", label: "Scheduled" };
  });
}

/** What "Pay now" would collect: the next unpaid installment, or the whole balance. */
export function nextPaymentCents(charge: DuesCharge, installments: Installment[], plan: Plan | null): number {
  if (charge.balance_cents <= 0) return 0;
  if (!plan || plan.status !== "active") return charge.balance_cents;
  const live = installments.filter((i) => i.status !== "cancelled").sort((a, b) => a.seq - b.seq);
  const net = charge.amount_paid_cents - charge.amount_refunded_cents;
  const settled = Math.max(net - plan.paid_before_cents, 0);
  let cumulative = 0;
  for (const i of live) {
    cumulative += i.amount_cents;
    if (cumulative > settled) return Math.min(cumulative - settled, i.amount_cents, charge.balance_cents);
  }
  return charge.balance_cents;
}

/** Per-installment amount of the monthly plan, first payment and last rounded. */
export function monthlyPreview(balanceCents: number, count: number): { each: number; last: number } {
  const each = Math.floor(balanceCents / count);
  return { each, last: each + (balanceCents % count) };
}
