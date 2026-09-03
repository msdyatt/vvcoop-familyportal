Stripe dues and payment migration — design

Status: design only. No Stripe account is connected, no code ships live from this
document. Every implementation PR that follows lands behind a feature flag in
Stripe **test mode**; a named human admin flips it to live.

Companion to `docs/dues-processor-options.html` (the 22 Aug finance memo), which
already settled the vendor question: **use Stripe, default families to ACH**.
This document specifies the data model, the Stripe mapping, the migration and
cutover rules, and the two views that sit on top.

---

## 1. Where dues live today

- `requirements` rows with `kind = 'dues'` carry `amount_per_family`,
  `amount_per_child`, `payment_url` (a Crowded link), `due_on`.
- `family_requirements` is the per-family status: `status`
  (`outstanding | sent | complete | waived`), `amount_due`, `amount_paid`,
  `paid_at`, `payment_method`, `payment_reference`.
- `lib/compliance.ts::duesFor()` computes `perFamily + perChild * activeChildren`.
  The amount is **snapshotted** into `family_requirements.amount_due` when the
  requirement is opened — "adding a child mid-year cannot silently change what a
  family was told they owe. Administrators recalculate explicitly."
- `app/family-village/admin/dues-import.tsx` reads a Crowded CSV, matches rows to
  households by adult email (name as fallback), and writes `family_requirements`
  after an admin reviews the preview.
- `integration_settings` has a seeded `dues` row, `status = 'not_configured'`.
- RLS pattern: a family reads its own `family_requirements` via
  `private.has_family_access(family_id)`; only `private.has_role('admin')` writes.
  Recording a payment or waiving an item is an admin action — a family cannot
  mark itself complete.

This design **keeps `requirements`/`family_requirements` as the compliance
surface** (the matrix, the "you owe X" card) and adds a money ledger beside it.
`family_requirements` stops being the source of truth for *amounts* — those move
to `dues_charges` — but its `status` still drives the compliance pills.

All money is stored as integer **cents** (`*_cents`), `currency` default `usd`.
Never `numeric` dollars in the new tables; the existing `numeric(10,2)` columns
stay for backward reads during migration.

---

## 2. Data model

### 2.1 `billing_customers` — family ↔ Stripe

| column | type | notes |
| --- | --- | --- |
| `family_id` | uuid PK → `families(id)` | one Stripe customer per household |
| `stripe_customer_id` | text unique | `cus_…` |
| `livemode` | boolean not null | test vs live; app refuses to mix |
| `default_pm_brand` | text null | `visa`, `us_bank_account`, … — **display only** |
| `default_pm_last4` | text null | display only |
| `default_pm_bank_name` | text null | ACH display only |
| `mandate_id` | text null | Stripe ACH mandate reference |
| `created_at` / `updated_at` | timestamptz | |

No card number, no CVC, no full bank account number — ever, anywhere. The only
card/bank facts stored are the brand + last four for a recognisable label, and
the Stripe PaymentMethod / mandate ids.

Created **lazily**: first time a family opens checkout, or during an
approval-gated migration batch. Never bulk-created for families that owe nothing.

### 2.2 `dues_charges` — what a family owes for one requirement

One row per `(requirement_id, family_id)` (mirrors the existing
`family_requirements` uniqueness).

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `requirement_id` | uuid → `requirements(id)` | |
| `family_id` | uuid → `families(id)` | |
| `school_year_id` | uuid → `school_years(id)` | denormalised for filtering |
| `currency` | text default `usd` | |
| `subtotal_cents` | int not null | snapshot of `duesFor()` at open time |
| `discount_total_cents` | int not null default 0 | sum of `dues_discount_lines` |
| `adjustment_total_cents` | int not null default 0 | signed sum of `dues_adjustments` |
| `amount_due_cents` | int generated `= subtotal - discount + adjustment`, floored at 0 |
| `amount_paid_cents` | int not null default 0 | maintained by webhook / import only |
| `amount_refunded_cents` | int not null default 0 | maintained by webhook only |
| `status` | text | `draft \| open \| partially_paid \| paid \| void \| uncollectible` |
| `stripe_invoice_id` | text unique null | set when an invoice is issued |
| `external_ref` | text unique null | migration idempotency key, see §4 |
| `void_reason` | text null | |
| `opened_by` / `voided_by` | uuid → `profiles(id)` | |
| `created_at` / `updated_at` | timestamptz | |

**Balance is defined once**, as a view, and both the portal and the invoicer
read it — never re-derived ad hoc:

```
balance_cents = amount_due_cents - amount_paid_cents + amount_refunded_cents
status:
  amount_due_cents = 0 and no payments      -> draft
  balance_cents <= 0                         -> paid
  0 < amount_paid_cents and balance_cents>0  -> partially_paid
  amount_paid_cents = 0                      -> open
  (admin) written off                        -> void / uncollectible
```

`amount_paid_cents` / `amount_refunded_cents` are **only** written by the Stripe
webhook and the migration importer. The portal "pay" action never touches them.

### 2.3 `dues_discount_types` + `dues_discount_lines` — discounts

Catalog:

| `dues_discount_types` | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `code` | text unique | `board_member`, `scholarship`, `early_bird`, … |
| `label` | text | shown to the family |
| `kind` | text | `percent \| fixed` |
| `value` | int | percent in basis points, or cents |
| `stripe_coupon_id` | text null | set only if it should appear on the Stripe invoice |
| `active` | boolean default true | |

Per-charge application (append-only; recalculated on an explicit admin action,
consistent with "administrators recalculate on purpose"):

| `dues_discount_lines` | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `charge_id` | uuid → `dues_charges(id)` | |
| `discount_type_id` | uuid null → `dues_discount_types(id)` | null = ad-hoc |
| `label` | text | frozen copy of the type label at apply time |
| `amount_cents` | int > 0 | the reduction, computed at apply time |
| `applied_by` | uuid → `profiles(id)` | |
| `applied_at` / `note` | | |

The per-child / per-family base formula stays in `duesFor()`. Discounts are for
*exceptions* (a board seat, a scholarship), not for expressing the normal
sibling rate.

### 2.4 `dues_adjustments` — manual signed line items

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `charge_id` | uuid → `dues_charges(id)` | |
| `amount_cents` | int (signed) | **positive raises** what's owed, **negative is a credit** |
| `reason` | text | `correction \| late_fee \| goodwill_credit \| hardship \| other` |
| `memo` | text | required free text |
| `created_by` | uuid → `profiles(id)` | |
| `reverses_adjustment_id` | uuid null → self | edits are done by reversing, never `UPDATE` |
| `created_at` | timestamptz | |

Adjustments never call Stripe. They move `amount_due_cents` only. A full waiver
maps to `dues_charges.status = 'void'` with a `void_reason` (and the linked
`family_requirements.status = 'waived'` for the compliance pill).

### 2.5 `dues_payment_plans` + `dues_installments` — schedules

| `dues_payment_plans` | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `charge_id` | uuid unique → `dues_charges(id)` | one active plan per charge |
| `installment_count` | int | |
| `cadence` | text | `monthly \| custom` |
| `first_due_on` | date | |
| `status` | text | `active \| completed \| cancelled` |
| `stripe_schedule_id` | text null | Stripe subscription schedule, if used |
| `created_by` | uuid | |

| `dues_installments` | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `plan_id` | uuid → `dues_payment_plans(id)` | |
| `seq` | int | 1..n |
| `due_on` | date | |
| `amount_cents` | int | sums to the charge balance at plan-creation time |
| `status` | text | `scheduled \| invoiced \| paid \| failed \| skipped \| cancelled` |
| `stripe_invoice_id` | text null | |
| `paid_at` | timestamptz null | |

Installments are **phase 2** — the finance memo flags that they multiply the
fixed 30¢ per-transaction fee and blunt the ACH cap. The schema is here so the
ledger doesn't need reshaping later. Ship one-payment dues first.

### 2.6 `dues_payments` — the money ledger (append-only)

Every attempt and every settlement. Nothing here is ever `UPDATE`d except the
status/Stripe-id fields the webhook advances on the same logical payment.

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | generated **before** any Stripe call |
| `charge_id` | uuid null → `dues_charges(id)` | null = unallocated credit / overpayment |
| `family_id` | uuid → `families(id)` | |
| `installment_id` | uuid null → `dues_installments(id)` | |
| `direction` | text | `charge \| refund` |
| `amount_cents` | int > 0 | sign comes from `direction` |
| `method` | text | `card \| us_bank_account \| cash \| check \| crowded \| other` |
| `status` | text | `pending \| processing \| succeeded \| failed \| canceled \| refunded` |
| `source` | text | `portal \| admin_manual \| migration_import \| stripe_dashboard` |
| `idempotency_key` | text unique | sent to Stripe; also blocks double-submit |
| `external_ref` | text unique null | imported rows: `crowded:<txn-id>` |
| `stripe_payment_intent_id` | text null | |
| `stripe_charge_id` | text null | |
| `stripe_refund_id` | text null | |
| `stripe_invoice_id` | text null | |
| `stripe_event_id` | text null | last webhook event that mutated this row |
| `failure_code` / `failure_message` | text null | from Stripe, surfaced to the family |
| `next_action` | text null | e.g. `requires_payment_method` |
| `initiated_by` | uuid null → `profiles(id)` | null for webhook-created rows |
| `approval_id` | uuid null → `billing_approvals(id)` | required for live charges/refunds |
| `occurred_at` | timestamptz | when money actually moved |
| `created_at` / `updated_at` | timestamptz | |

Partial unique index — **at most one in-flight payment per charge**:

```sql
create unique index dues_payments_one_open_per_charge
  on dues_payments (charge_id)
  where direction = 'charge' and status in ('pending', 'processing');
```

### 2.7 `billing_approvals` — explicit sign-off for any live billing action

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `action` | text | `charge \| refund \| void \| customer_migrate \| enable_livemode \| bulk_invoice` |
| `target_type` / `target_id` | text / uuid | charge, payment, family, or `null` for `enable_livemode` |
| `amount_cents` | int null | bounds what the approval authorises |
| `requested_by` | uuid → `profiles(id)` | |
| `request_note` | text | |
| `status` | text | `pending \| approved \| rejected \| expired \| consumed` |
| `approved_by` | uuid null → `profiles(id)` | **must be a human admin, ≠ `requested_by`** |
| `approved_at` | timestamptz null | |
| `expires_at` | timestamptz | short TTL (e.g. 30 min) |
| `consumed_by_payment_id` | uuid null → `dues_payments(id)` | |
| `created_at` | timestamptz | |

Constraint: `approved_by is null or (approved_by <> requested_by)`. Enforced
further in the edge function — `approved_by` must hold `admin` in `user_roles`
and be an `auth.users` human (not a service/agent principal).

### 2.8 `stripe_webhook_events` — idempotent inbox

| column | type | notes |
| --- | --- | --- |
| `id` | text PK | Stripe `event.id` |
| `type` | text | `payment_intent.succeeded`, … |
| `livemode` | boolean | |
| `payload` | jsonb | raw event, for replay/debug |
| `received_at` | timestamptz | |
| `processed_at` | timestamptz null | |
| `process_error` | text null | |
| `attempts` | int default 0 | |

Insert-on-arrival with `on conflict (id) do nothing`; if the row already has
`processed_at`, the handler returns `200` immediately. This is the primary
double-charge guard on the inbound side.

### 2.9 Audit

Reuse `public.audit_log`. Every mutating billing action writes a row: actor,
action, target, before/after JSON. The reconciliation view reads it as the
payment's history strip.

### 2.10 RLS

Mirrors the existing compliance tables exactly.

- `billing_customers`, `dues_charges`, `dues_payments`, `dues_discount_lines`,
  `dues_adjustments`, `dues_payment_plans`, `dues_installments`:
  - **family read**: `for select using (private.has_family_access(family_id))`
    (join through `charge_id` where the table has no direct `family_id`).
  - **admin read**: `for select using (private.has_role('admin'))`.
  - **write**: `for all using (private.has_role('admin'))` — plus service-role
    for the webhook / edge functions. Families never write.
- `dues_discount_types`: read `private.is_active_user()`, write `admin`.
- `billing_approvals`, `stripe_webhook_events`: **admin + service-role only**,
  no family read (approval fields and raw payloads never reach a family).
- Same `authenticated` grants + `touch_updated_at` triggers as
  `20260822143610_family_compliance.sql`.
- Privileged edge functions call `needsMfaStepUp()` (`_shared/aal.ts`) before any
  service-role write, same as the OpenSign functions.

---

## 3. Stripe mapping — no card data in the app

### 3.1 Objects

| Portal concept | Stripe object | Link |
| --- | --- | --- |
| Household | Customer | `billing_customers.stripe_customer_id`; `metadata.family_id` |
| A year's dues for a family | Invoice (recommended) | `dues_charges.stripe_invoice_id`; `metadata.charge_id`, `family_id`, `school_year_id`, `requirement_id` |
| A payment attempt | PaymentIntent | `dues_payments.stripe_payment_intent_id` |
| Settlement | Charge | `dues_payments.stripe_charge_id` |
| Refund | Refund | `dues_payments.stripe_refund_id` |
| Saved card / bank | PaymentMethod | id + brand + last4 only |
| Installments (phase 2) | Subscription Schedule | `dues_payment_plans.stripe_schedule_id` |

**Recommend Stripe Invoices** for dues rather than bare PaymentIntents: hosted
invoice + receipt pages, built-in ret/dunning email schedule, PDF for the
treasurer, and clean one-to-one reconciliation. Every Stripe object carries
`metadata.charge_id` so a webhook can always find its local row.

### 3.2 How card/bank data is kept out

- Card and bank entry happens **only** in Stripe's UI — a **Checkout Session**
  (hosted) or **PaymentElement** (embedded, Stripe.js). The PAN / CVC / full
  account number never reach our Worker or Postgres.
- To save a method for reuse: **SetupIntent** via the same element.
- We persist: PaymentMethod id, `brand`/`funding`/`last4`, `exp_month`/`exp_year`
  for a card; `bank_name`/`last4`/`mandate_id` for ACH. All display-only.
- ACH-first per the finance memo: element configured with `us_bank_account`
  ordered ahead of `card`; card stays available. Bank verification via Stripe
  Financial Connections / instant verification, falling back to micro-deposits.
- PCI scope stays **SAQ A** (fully outsourced entry).

### 3.3 Secrets

- `STRIPE_SECRET_KEY` (test + live variants), `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PUBLISHABLE_KEY` in **Supabase Vault**, read only by `service_role`
  through `public.read_vault_secret()` (existing pattern from
  `20260826215137_read_vault_secret_service_role_only.sql`).
- Publishable key is exposed to the browser (it is public by design) via a
  small edge endpoint or build-time env, gated by `dues.provider`.
- `integration_settings.dues` tracks connection status / `last_checked_at`.

### 3.4 Edge functions (all new, `verify_jwt` per line)

| function | `verify_jwt` | purpose |
| --- | --- | --- |
| `stripe-webhook` | false | verify `Stripe-Signature`, dedupe on `event.id`, drive the ledger |
| `stripe-create-checkout` | true | family-initiated; creates/opens Customer + Invoice/PaymentIntent, returns client secret / Checkout URL |
| `stripe-admin-action` | true | admin refund / void / bulk-invoice / enable-livemode — resolves a `billing_approvals` row first |
| `stripe-reconcile` | true (cron) | nightly Stripe-vs-ledger diff, writes the reconciliation panel data |

`stripe-webhook` follows `opensign-webhook/index.ts`: constant-time secret
check, `logEdgeError` on throw, always `200` once the event is safely recorded so
Stripe stops retrying.

Events handled: `checkout.session.completed`, `payment_intent.processing`,
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`charge.succeeded`, `charge.failed` (late ACH return), `charge.refunded`,
`invoice.finalized`, `invoice.paid`, `invoice.payment_failed`,
`invoice.marked_uncollectible`, `setup_intent.succeeded`, `customer.updated`,
`charge.dispute.created`.

---

## 4. Migration and cutover — no duplicate invoices or charges

### 4.1 Idempotency rules (the whole point)

1. **Stripe Idempotency-Key on every create call** = `dues_payments.id`
   (`pay_<uuid>`), persisted as `pending` *before* the call. A retry reuses the
   same key, so Stripe returns the original object instead of a second charge.
2. **`dues_payments.external_ref` UNIQUE** — a migration import for
   `crowded:<txn>` can be inserted at most once. The importer upserts on it.
3. **`dues_charges.external_ref` / `stripe_invoice_id` UNIQUE** — a charge that
   already has a non-void `stripe_invoice_id` is never invoiced again.
4. **Never invoice a charge whose balance ≤ 0.** The batch invoicer filters on
   the balance view before it calls Stripe.
5. **One in-flight payment per charge** (partial unique index, §2.6) — a
   double-click or refresh cannot open a second PaymentIntent.
6. **Webhook inbox dedupes on `event.id`** (§2.8) — a redelivered event is a
   no-op.
7. **Only the webhook and the importer write `amount_paid_cents`.** The portal
   pay action creates a `pending` row and nothing else, so a failed/duplicated
   client call can't inflate a balance.
8. **Remove `requirements.payment_url`** (the Crowded link) as part of cutover,
   so no family can pay in both systems.

### 4.2 Phased plan

**Phase 0 — build (test mode).** Ship schema, RLS, views, edge functions, and
both UIs behind `integration_settings.dues.status` / a `dues.provider` flag with
values `off | stripe_test | stripe_live`. Seed `dues_discount_types`. Nothing is
visible to families. All Stripe calls use the **test** key.

**Phase 1 — backfill history.** Extend `dues-import.tsx` to write the new ledger:
each matched CSV row becomes a `dues_payments` row with `source =
'migration_import'`, `method = 'crowded'`, `status = 'succeeded'`,
`external_ref = 'crowded:' + <txn id or stable line hash>`. Recompute
`dues_charges` for every family from `requirements` + `children` + imported
payments + any discounts/adjustments. Re-runnable. Output a reconciliation
report: matched / unmatched / ambiguous / amount-mismatch, for an admin to clear.

**Phase 2 — freeze + snapshot.** Announce a cutover date. Stop recording
payments through the old path. Snapshot every `dues_charges` balance. Families
already paid in full for the current year are set `status = 'paid'` and are
**excluded from customer creation and never invoiced** (guard #4).

**Phase 3 — go live (approval-gated).** A named human admin creates and approves
a `billing_approvals` row `action = 'enable_livemode'`. Only then does
`dues.provider` move to `stripe_live` and can live PaymentIntents/Invoices be
created. Verify live webhook signing secret and a 1¢ round-trip first.

**Phase 4 — issue invoices in reviewed batches.** Admin selects families, sees
each computed amount (base − discounts + adjustments − prior payments), and one
`billing_approvals` row `action = 'bulk_invoice'` (with `amount_cents` =
batch total) authorises that batch. The issuer skips any charge failing guards
3 or 4.

**Rollback:** `dues.provider = off` stops all new Stripe activity immediately;
the ledger and any in-flight Stripe objects are unaffected and reconcile on the
next run. Restore `requirements.payment_url` if the co-op needs to fall back to
Crowded links.

### 4.3 Cutover checklist

- [ ] Live keys + webhook secret in Vault, `read_vault_secret` grants verified
- [ ] Live webhook endpoint registered, signature verified with a test event
- [ ] Backfill importer run; reconciliation report has zero unresolved rows
- [ ] Balances snapshotted; paid-in-full families marked and excluded
- [ ] `requirements.payment_url` cleared
- [ ] `billing_approvals` `enable_livemode` approved by a named human admin
- [ ] 1¢ live charge + refund round-trip reconciles
- [ ] Family "Pay now" hidden until this list is complete

---

## 5. Failed payments

- `payment_intent.payment_failed` / `invoice.payment_failed` → matching
  `dues_payments` row `status = 'failed'`, `failure_code` / `failure_message`
  stored and shown to the family. The `dues_charges` balance is untouched
  (stays `open` / `partially_paid`).
- **ACH returns come days later.** A payment can go `pending → processing →
  succeeded` and *then* fail via `charge.failed` (e.g. R01 insufficient funds).
  The handler moves it back to `failed`, decrements `amount_paid_cents`, and
  raises a reconciliation-panel alert. The `processing` state is first-class in
  the UI ("Payment in progress — bank transfers take 1–4 business days").
- **Dunning** is Stripe's job: Invoice automatic retries + reminder emails on a
  configured schedule. No hand-rolled ret/cron. The portal shows "Payment
  failed — retry" with a fresh PaymentElement.
- `invoice.marked_uncollectible` → `dues_charges.status = 'uncollectible'`;
  surfaced to admins, never auto-written-off.
- `charge.dispute.created` → flag the charge, alert admins, take no automatic
  action.

---

## 6. Refunds

- Admin-initiated only, from the reconciliation view, against a specific
  `dues_payments` row with `status = 'succeeded'`.
- Requires a `billing_approvals` row `action = 'refund'`, `amount_cents ≤` the
  settled amount, `approved_by` a human admin ≠ requester.
- `stripe-admin-action` creates the Stripe Refund with an Idempotency-Key,
  inserts a `dues_payments` row `direction = 'refund'`, links `stripe_refund_id`.
  `charge.refunded` webhook confirms and bumps `amount_refunded_cents`.
- Partial refunds allowed; cumulative refunds capped at the settled amount by a
  check in the edge function and a DB constraint
  (`amount_refunded_cents <= amount_paid_cents`).
- **Offline refund** (co-op writes a cheque): `method = 'check'`,
  `source = 'admin_manual'`, no Stripe call — still an approval + audit row.
- Refunding does not reopen the compliance item automatically; an admin decides
  whether `family_requirements.status` reverts.

---

## 7. Manual adjustments and discounts

- **Discounts**: pick from `dues_discount_types` (percent or fixed) or enter an
  ad-hoc line. Written to `dues_discount_lines`, `dues_charges.discount_total_cents`
  recomputed. If `stripe_coupon_id` is set the reduction shows as a coupon on the
  Stripe invoice; otherwise it is folded into the invoiced amount. Applied
  **before** an invoice is issued.
- **Adjustments**: `dues_adjustments`, signed cents, `reason` + required `memo` +
  `created_by`. Immutable — a mistake is fixed with a reversing row
  (`reverses_adjustment_id`). Never hits Stripe.
- **Full waiver**: `dues_charges.status = 'void'` + `void_reason`, and
  `family_requirements.status = 'waived'` for the compliance pill.
- **Scholarship / hardship**: either a 100% discount type or a negative
  adjustment — both leave an auditable reason and a named actor.
- **Account credit** (a family overpaid, or an adjustment pushed the balance
  negative): a `dues_payments` row with `charge_id = null`, `direction = 'charge'`,
  `method` offline, representing a credit carried to next year's charge. Or the
  admin issues a refund. Balance never goes below zero on the charge itself.
- Every recalculation is an explicit admin action, matching the existing
  `duesFor()` philosophy — nothing re-prices itself on read.

---

## 8. Admin reconciliation view (spec)

Route: **Admin → Dues** (new tab, or the dues half of Compliance promoted).

- **Ledger table** — one row per `dues_charges`: family, school year, base,
  discounts, adjustments, paid, refunded, **balance**, status. Filter by year /
  status / method; search by family. Sort by balance.
- **Payments feed** — chronological `dues_payments`: date, family, amount,
  method (`Visa ••4242`, `Bank ••6789`), status, source, initiated-by,
  approved-by, and a deep link to the Stripe dashboard object.
- **Reconciliation panel** — output of the nightly `stripe-reconcile` job:
  - Stripe objects with no local row
  - local rows with no Stripe object
  - amount mismatches
  - ACH stuck in `processing` beyond N days
  - failed payments awaiting follow-up
  Each with a one-click resolve / link-manually action.
- **Actions** (all audit-logged; live ones approval-gated): record offline
  payment, apply discount, add adjustment / reversal, issue refund, void charge,
  resend invoice, retry failed payment, create/repair `billing_customers` link.
- **Batch invoicing** — select families → preview computed amounts → request
  approval → issue. Skips charges that fail the duplicate guards, and says so.
- **Approvals inbox** — pending `billing_approvals`, approve / reject, TTL shown.
- **Export** — CSV of the ledger and of the payments feed, for the treasurer /
  board.

## 9. Family payment-history view (spec)

Route: **Family portal → home**, the existing dues card, expanded.

- **What you owe** — per dues requirement: base amount, each discount (labelled),
  each adjustment (labelled), amount paid, **balance**, due date. Installment
  schedule if a plan exists.
- **Pay now** — opens the Stripe PaymentElement / Checkout (ACH preselected,
  card available). Disabled while a payment is `pending` / `processing`, with
  "Payment in progress — bank transfers take 1–4 business days."
- **History** — every `dues_payments` row for the family: date, amount, method
  as a friendly label, status (`Paid` / `Processing` / `Failed — retry` /
  `Refunded`), and a receipt / invoice-PDF link (Stripe hosted).
- **Failed payment** — inline reason (`Your bank declined the transfer`) + a
  Retry button that opens a fresh element.
- **RLS** — family sees only its own `dues_charges` / `dues_payments` /
  `dues_discount_lines` / `dues_adjustments` via `private.has_family_access`.
  No approval fields, no webhook payloads, no other household's data. All writes
  are admin / service-role.
- Card and bank details shown are display strings only; there is no stored PAN.

---

## 10. Live-billing approval gate (explicit)

- `dues.provider`: `off → stripe_test → stripe_live`. Moving to `stripe_live`
  needs an **approved `billing_approvals` row created by a named human admin** —
  not by an agent, not by a service principal.
- Any code path that uses the **live** secret key to move money —
  `PaymentIntent` confirm, `Invoice.finalize` / `pay`, `Refund.create`, bulk
  invoice — must first resolve a `billing_approvals` row: `status = 'approved'`,
  not expired, `action` + `target` + `amount_cents` matching the request,
  `approved_by` a human admin `≠` the requester. Otherwise the edge function
  returns `403`.
- **Test mode needs no approval** and is badged clearly in the UI.
- The building agent will not create, connect, or trigger any live Stripe
  resource. Every implementation PR ships in test mode behind the flag; a human
  performs the live cutover.

---

## 11. Suggested build order (sub-issues — not yet created)

1. Schema migration + RLS + balance view + `touch_updated_at` triggers.
2. `stripe-webhook` edge function + Vault secrets + `stripe_webhook_events` inbox.
3. `stripe-create-checkout` (test mode) + publishable-key plumbing.
4. Migration importer (extend `dues-import.tsx`) + reconciliation report.
5. Admin **Dues** reconciliation UI + approvals inbox.
6. Family payment-history + **Pay now** UI.
7. `stripe-reconcile` nightly job + reconciliation panel.
8. Cutover runbook execution + `enable_livemode` approval (human).
9. *(Phase 2)* installment plans.

## 12. Open questions for Sam / the board

- Real roster size and typical children per family — firms up fee modelling and
  whether an installment option is worth building.
- Does the co-op **absorb** the processing fee or **pass it on**? (Board call;
  changes whether families see one price or two.)
- CPA confirmation on whether dues qualify for Stripe's 501(c)(3) nonprofit
  rate (finance memo, finding one).
- One payment or installments for the first live year? (Recommend one.)
- Who are the named human approvers for live billing actions?
