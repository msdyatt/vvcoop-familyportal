import { applyFetchedPaymentIntent } from "./stripe-events.ts";
import { friendlyFailure, StripeError, type StripeClient } from "./stripe.ts";
import type { AdminClient } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

export type DailySummary = {
  expired: number; reminders: number; pruned: number;
  autopay: { attempted: number; started: number; failed: number; skipped: number };
};

async function call(admin: AdminClient, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/**
 * The daily run: tidy abandoned attempts, queue reminders, drop old event
 * payloads, and collect each household's next due installment from the method it
 * saved. `stripe` is null when Stripe is not configured or billing is off; the
 * housekeeping still runs, nothing is charged.
 *
 * Collection is deliberately cautious. One installment per household per run,
 * always the earliest unpaid one; a failed attempt waits `retry_after_days`
 * before the next; after `max_attempts` it stops and an administrator is told.
 * The pending row exists before Stripe is called and its id is the
 * Idempotency-Key, so a rerun cannot charge twice.
 */
export async function runDuesDaily(deps: { admin: AdminClient; stripe: StripeClient | null }, today: string): Promise<DailySummary> {
  const { admin, stripe } = deps;
  const summary: DailySummary = {
    expired: Number(await call(admin, "billing_expire_stale")),
    reminders: Number(await call(admin, "billing_queue_reminders", { p_today: today })),
    pruned: Number(await call(admin, "billing_prune_webhook_events")),
    autopay: { attempted: 0, started: 0, failed: 0, skipped: 0 },
  };
  if (!stripe) return summary;

  const due = (await call(admin, "billing_due_autopay", { p_today: today })) as { installment_id: string }[];
  for (const row of due ?? []) {
    summary.autopay.attempted++;
    let begun: any;
    try {
      begun = await call(admin, "billing_begin_autopay", { p_installment: row.installment_id, p_today: today });
    } catch {
      summary.autopay.skipped++;   // another run or a payment got there first
      continue;
    }
    try {
      const pi = await stripe.post("/v1/payment_intents", {
        amount: begun.amount_cents,
        currency: "usd",
        customer: begun.stripe_customer_id,
        payment_method: begun.payment_method_id,
        payment_method_types: [begun.method === "us_bank_account" ? "us_bank_account" : "card"],
        confirm: true,
        off_session: true,
        description: "Veritas Village dues installment",
        metadata: { payment_id: begun.payment_id, charge_id: begun.charge_id, family_id: begun.family_id, installment_id: row.installment_id, source: "autopay" },
        expand: ["latest_charge"],
      }, `pay_${begun.payment_id}`);
      const outcome = await applyFetchedPaymentIntent({ admin, stripe }, pi, null, { finalFailure: true });
      if (outcome.startsWith("failed")) summary.autopay.failed++; else summary.autopay.started++;
    } catch (error) {
      if (error instanceof StripeError) {
        // A declined card or a bank that refuses the debit comes back as an error
        // that still carries the PaymentIntent; anything else is recorded as failed too.
        const attached = error.raw?.error?.payment_intent;
        if (attached?.id) {
          await applyFetchedPaymentIntent({ admin, stripe }, attached, null, { finalFailure: true });
        } else {
          await call(admin, "billing_apply_payment_update", {
            p_payment: begun.payment_id, p_status: "failed", p_event_id: null,
            p_fields: { failure_code: error.code, failure_message: friendlyFailure(error.code, error.message) },
          });
        }
        summary.autopay.failed++;
      } else {
        // Could not reach Stripe: the row stays pending. The same idempotency key
        // means Stripe's answer, whenever it arrives, lands on this row.
        summary.autopay.skipped++;
      }
    }
  }
  return summary;
}
