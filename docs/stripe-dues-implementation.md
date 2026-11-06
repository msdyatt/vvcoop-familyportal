# Stripe dues: what was built, and where it differs from the design

Companion to `docs/stripe-dues-migration-design.md` (PR #10) and the finance memo
`docs/dues-processor-options.html`. The design was reviewed against the code as it is
today before any of it was built. This file records the changes that review made, so
the two documents do not quietly disagree. It is engineering notes, not legal advice;
questions for the co-op's attorney are collected at the end.

Everything here runs in Stripe **test mode** until a human administrator turns live
mode on (see "Going live").

## Where the build differs from the design

| Design said | Built | Why |
| --- | --- | --- |
| One Stripe **Invoice** per charge, a PaymentIntent per attempt | One hosted **Checkout Session** per payment attempt (card, bank transfer, Apple Pay and Google Pay all appear there), plus off-session PaymentIntents for automatic installments | Stripe Invoicing adds its own per-invoice fee on top of processing, and the co-op absorbs fees. Checkout shows wallets without domain registration. The portal makes its own receipts and runs its own reminders, so the invoice features were not buying anything |
| `amount_paid_cents` / `amount_refunded_cents` updated by the webhook (increment and decrement) | Both are **recomputed from the payment ledger** by `private.recompute_charge()` after every change | Incrementing breaks on out-of-order events and on an ACH return that arrives after settlement. Recomputing from the ledger cannot drift |
| Admins write money tables through `for all` RLS policies | **No write grants at all.** Browsers read; every change is a `SECURITY DEFINER` function that checks role and two-factor level (`private.require_billing_admin()`) | Matches the messaging and account-deletion migrations; an admin cannot type a paid total |
| RLS: family read, admin read, admin write | Adds the restrictive `aal2_required` policy (the global one only covered tables that existed when it ran) and a restrictive `demo_isolation` policy | New tables fall outside the one-off `aal2` migration unless it is repeated |
| `amount_refunded_cents <= amount_paid_cents` as a check constraint | The refund total is clamped to the paid total when recomputed; refund creation caps against what is left on the payment | A constraint would turn a late ACH return after a refund into a failed webhook |
| `billing_customers.family_id` primary key | Unique on `(family_id, livemode)` | A test-mode customer id is meaningless in live mode, so the same household needs one row per mode |
| `dues_charges.status` includes `draft` | Dropped. A charge is `open`, `partially_paid`, `paid`, `void` or `uncollectible` | A charge is only created when dues are opened, so there is no unissued state |
| Installments as a Stripe Subscription Schedule (phase 2) | Installments are rows in `dues_installments`; paid-ness is "money paid so far, applied in due-date order" | Works the same however a payment arrived (card, bank, cash). A daily job collects the earliest unpaid installment from a saved method |
| Refund requires an approval | Required for **live** refunds only. Test mode needs none | Matches section 10 of the design |
| Every live money action needs an approval | `enable_livemode` once, plus each refund. Family-initiated payments and installments the family authorised at checkout are covered by `enable_livemode` | A family paying its own dues cannot wait on a second administrator |
| Test and live mixed | Payments and customers carry `livemode`. In test mode everything counts toward balances; in live mode only real money does. `admin_purge_test_billing_data()` removes test rows before launch | Lets the co-op rehearse, then start clean |
| Webhook payloads kept forever | Payload nulled after 90 days (`billing_prune_webhook_events`) | Stripe events can contain names and emails |
| Deleting a household cascades | `ON DELETE RESTRICT` on every billing foreign key, and a trigger on `families` that refuses for an administrator and **keeps the household (renamed "Former household", children and documents removed)** when a member erases their own account | The co-op has to keep its payment records |

Not built from the design: the nightly `stripe-reconcile` job. Reconciliation is an
on-demand "Check with Stripe" action in the admin Dues tab instead, so there is no
background job to monitor before the first live year.

## The rules the database enforces

- Money is integer cents. No card number, bank account number or CVC is stored anywhere;
  only Stripe ids and a brand / last four for a recognisable label.
- The payment ledger (`dues_payments`) is append-only: no deletes, no edits to amount,
  family, direction, source or mode, and status only moves forward (`pending` →
  `processing` → `succeeded` → `failed` for a late ACH return). A failed payment is never
  revived; the family pays again and gets a new row.
- Adjustments and discount lines are append-only. An adjustment is undone with a
  reversing entry, never edited.
- At most one payment attempt is in flight per charge (partial unique index), and the
  amount is always decided in SQL: the next installment, or the whole balance.
- A Stripe event is received once (`stripe_webhook_events`, keyed by Stripe's event id).
- A live action needs an approved `billing_approvals` row by a different, active
  administrator, unexpired and matching the action, target and amount; it is spent when used.

## Going live (a human decision)

1. Rehearse in test mode; run `admin_purge_test_billing_data()` (Admin → Dues → Settings).
2. Put the live keys in Vault (see `docs/stripe-setup-checklist.md`).
3. Administrator A requests `enable_livemode`; administrator B approves it; then A
   switches the mode. The building agent never does any of this.
4. Turn off the old Crowded payment link for the year (clear `requirements.payment_url`).

## Questions for the co-op's attorney / CPA

- **Card surcharging.** The co-op absorbs fees, so no surcharge is applied. If the board
  ever passes fees on, card surcharges are restricted or banned in some states and by card
  network rules.
- **Receipts.** The receipt says what was paid, when, how, and the co-op's name and EIN
  (filled in by an administrator). It does not say the payment is tax-deductible. Whether
  dues for classes qualify as a contribution, and what wording a receipt needs, is a
  question for the CPA.
- **Nonprofit processing rate.** The finance memo notes Stripe's rate usually needs mostly
  donation volume. Confirm before budgeting.
- **Retention.** The design keeps payment records for as long as the household row exists
  and never deletes them. Confirm the period the co-op wants (seven years is common for
  nonprofit financial records) and what to do with a "Former household" after it.
- **Automatic payments.** The checkout screen shows the bank or card authorisation text
  Stripe provides. Confirm that is enough consent for recurring ACH under NACHA rules, and
  whether the terms should say more.
- **Sales or use tax, and the 1099-K threshold**, if any apply to dues.
