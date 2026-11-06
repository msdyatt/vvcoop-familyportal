/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import {
  describeInstallments, formatCents, formatDueDate, methodLabel, monthlyPreview, nextPaymentCents, parseDollars, paymentStatusLabel,
  type DuesCharge, type Installment, type Plan,
} from "./dues.ts";

const charge = (over: Partial<DuesCharge> = {}): DuesCharge => ({
  id: "c1", requirement_id: "r1", family_id: "f1", school_year_id: "y1", subtotal_cents: 60000, discount_total_cents: 0, adjustment_total_cents: 0,
  amount_due_cents: 60000, amount_paid_cents: 0, amount_refunded_cents: 0, balance_cents: 60000, status: "open", void_reason: null, disputed_at: null,
  family_name: "Smith", requirement_title: "Dues", due_on: "2026-09-01", ...over,
});
const plan: Plan = { id: "p1", charge_id: "c1", kind: "monthly", status: "active", paid_before_cents: 0 };
const installment = (seq: number, due_on: string, amount_cents: number, status: Installment["status"] = "scheduled"): Installment => ({
  id: `i${seq}`, plan_id: "p1", charge_id: "c1", seq, due_on, amount_cents, status, paid_at: null, attempts: 0, needs_attention: false,
});

Deno.test("money is formatted from cents, and typed dollars are parsed strictly", () => {
  assertEquals(formatCents(123456), "$1,234.56");
  assertEquals(formatCents(5), "$0.05");
  assertEquals(formatCents(-2500), "-$25.00");
  assertEquals(formatCents(null), "—");
  assertEquals(parseDollars("$1,250.5"), 125050);
  assertEquals(parseDollars("300"), 30000);
  assertEquals(parseDollars("0.07"), 7);
  assertEquals(parseDollars("12.345"), null);
  assertEquals(parseDollars("abc"), null);
  assertEquals(parseDollars("-5"), null);
});

Deno.test("a due date stays on the day it was set", () => {
  assertEquals(formatDueDate("2026-09-01"), "Sep 1, 2026");
  assertEquals(formatDueDate("2026-09-01T00:00:00+00:00"), "Sep 1, 2026");
});

Deno.test("payment methods read the way a family would say them", () => {
  assertEquals(methodLabel({ method: "card", wallet: "apple_pay", brand: "visa", last4: "4242", bank_name: null }), "Visa ••4242 · Apple Pay");
  assertEquals(methodLabel({ method: "us_bank_account", wallet: null, brand: null, last4: "6789", bank_name: "Test Bank" }), "Bank ••6789 (Test Bank)");
  assertEquals(methodLabel({ method: "check", wallet: null, brand: null, last4: null, bank_name: null }), "Check");
  assertEquals(methodLabel({ method: null, wallet: null, brand: null, last4: null, bank_name: null }), "—");
});

Deno.test("history labels: a refund is its own line and the original stays Paid", () => {
  assertEquals(paymentStatusLabel({ status: "succeeded", direction: "charge" }).text, "Paid");
  assertEquals(paymentStatusLabel({ status: "processing", direction: "charge" }).text, "Processing");
  assertEquals(paymentStatusLabel({ status: "failed", direction: "charge" }).text, "Failed");
  assertEquals(paymentStatusLabel({ status: "succeeded", direction: "refund" }).text, "Refunded");
  assertEquals(paymentStatusLabel({ status: "pending", direction: "refund" }).text, "Refund pending");
});

Deno.test("the schedule marks paid, past due, next and later installments", () => {
  const views = describeInstallments([
    installment(1, "2026-09-01", 6667, "paid"), installment(2, "2026-10-01", 6667), installment(3, "2026-11-01", 6667), installment(4, "2026-12-01", 6667), installment(5, "2027-01-01", 100, "cancelled"),
  ], "2026-11-15");
  assertEquals(views.map((v) => v.display), ["paid", "overdue", "overdue", "scheduled"]);
  const early = describeInstallments([installment(1, "2026-09-01", 100, "paid"), installment(2, "2026-10-01", 100), installment(3, "2026-11-01", 100)], "2026-09-20");
  assertEquals(early.map((v) => v.display), ["paid", "due", "scheduled"]);
});

Deno.test("what Pay now collects: the next installment, or the whole balance with no plan", () => {
  const installments = [installment(1, "2026-09-01", 20000), installment(2, "2026-10-01", 20000), installment(3, "2026-11-01", 20000)];
  assertEquals(nextPaymentCents(charge(), installments, null), 60000);
  assertEquals(nextPaymentCents(charge(), installments, plan), 20000);
  // A partial offline payment of $50 leaves $150 of the first installment still to pay.
  assertEquals(nextPaymentCents(charge({ amount_paid_cents: 5000, balance_cents: 55000 }), installments, plan), 15000);
  // The first is paid in full: the second is next.
  assertEquals(nextPaymentCents(charge({ amount_paid_cents: 20000, balance_cents: 40000 }), installments, plan), 20000);
  // A deposit paid before the plan existed is not counted against the installments.
  assertEquals(nextPaymentCents(charge({ amount_paid_cents: 10000, balance_cents: 50000 }), installments, { ...plan, paid_before_cents: 10000 }), 20000);
  assertEquals(nextPaymentCents(charge({ balance_cents: 0, status: "paid" }), installments, plan), 0);
});

Deno.test("monthly split puts the rounding on the last payment", () => {
  assertEquals(monthlyPreview(60000, 9), { each: 6666, last: 6666 + 6 });
  assertEquals(monthlyPreview(60000, 10), { each: 6000, last: 6000 });
});
