# Forms and electronic signatures

Authoritative spec and operations reference for required family paperwork and
its electronic signatures. Covers what is required, who signs, how versions and
renewals work, what evidence is kept, how it is exported, how long it is
retained, and what still needs a decision before the co-op relies on this in
production.

Written against the code as it stands (`lib/compliance.ts`,
`app/family-village/compliance-panel.tsx`,
`app/family-village/admin/compliance-tab.tsx`,
`supabase/functions/opensign-*`, `supabase/functions/_shared/opensign.ts`, and
the `family_compliance` / `opensign_signature_requests` migrations). Sections
marked **ASSUMPTION** encode a policy choice that is the co-op's to confirm, not
the code's to dictate — Sam should confirm or correct each before a legal
review.

---

## 1. How it works today

### Data model

| Table | What it holds |
| --- | --- |
| `school_years` | The scoping spine. One row is `is_current` (partial unique index enforces "exactly one"). A `2026-27` requirement does not carry into `2027-28`. |
| `requirements` | What every family owes in a given year. `kind = 'document'` (sign) or `kind = 'dues'` (pay). A document requirement points at an OpenSign template (`opensign_template_id`, preferred), a shared public link (`public_sign_url`), and/or an uploaded PDF (`document_id`). |
| `family_requirements` | The per-family matrix cell. `status` ∈ `outstanding` \| `sent` \| `complete` \| `waived`. Carries the signing URL, `provider_document_id`, `signed_at`, `signed_by_user_id`, `signed_document_id`, `certificate_url`, `last_synced_at`. |
| `signature_requests` | One row per signer per send. `status` ∈ `pending` → `sent` → `viewed` → `signed` \| `declined` \| `expired` \| `failed`. Records `signer_email`, `signer_name`, `requested_by_user_id`, `requested_at`, `completed_at`, `signing_url`, `error_detail`. |
| `documents` | Stored PDFs. A completed signature produces a new `kind = 'signed'` row with the signed PDF in `family-village-private/signed/<uuid>.pdf`, scoped to `family_id`. |
| `compliance_reminder_log` | Idempotency ledger for the daily reminder cron (`send_compliance_reminders`, 13:00 UTC, thresholds 7 / 1 / 0 days before `due_on`). |
| `audit_log` | Admin actions: `requirement_opened`, `requirement_status_changed`, `signature_link_created`, `requirement_deleted`, `reminder_sent`. |

### Signing provider

OpenSign, API **v1.2**. Base URL is per-install, stored in
`integration_settings.api_base_url` (cloud is
`https://app.opensignlabs.com/api/v1.2`). Three edge functions:

- **`opensign-send`** — admin + AAL2 gated. Sends a requirement to one household
  from its template (`POST /createdocument/:template_id`, keeps the co-op's
  hand-placed signature fields) or, as a fallback, from an uploaded PDF
  (`POST /createdocument`, drops a signature box on page 1). Writes the signing
  URL back onto `family_requirements` so the family can sign inside the portal.
- **`opensign-sync`** — admin + AAL2 gated, also scheduled. Polls
  `GET /document/:id` for everything `sent`/`outstanding` with a
  `provider_document_id`, stores the signed PDF + certificate, flips the row to
  `complete`. This is the path that works without any webhook secret and the
  safety net for missed callbacks.
- **`opensign-webhook`** — `verify_jwt = false`, authenticated by a shared
  secret compared in constant time (`OPENSIGN_WEBHOOK_SECRET`). Fails **closed**
  (503) when the secret is unset. The instant path; optional.

### Family experience

`ComplianceBanner` (one line under the header, hidden when nothing is
outstanding) + `CompliancePanel` (the full `#paperwork` list). A document row
shows a **Sign now ↗** button pointing at the per-family `signing_url` when one
exists, otherwise the shared `public_sign_url`. Signed items show **Download
copy** (a short-lived signed URL to the stored PDF). OpenSign's signing page is
opened in a new tab — it renders nothing inside an iframe.

### Admin experience

Admin → Compliance: a families × requirements matrix. Each cell is a status
label only (`Signed 3 Sep 2026`, `Awaiting signature`, `Unpaid`, `Not
required`, `Not opened`). Actions: open a requirement to all families, attach a
template / public link / PDF, send to one or all families, **Check for
signatures** (runs `opensign-sync`), and a per-cell editor to record a
signature, record a payment, waive, or reset.

---

## 2. Required form types

**ASSUMPTION — Sam to confirm the list.** The portal does not hard-code a form
catalog; an admin creates `requirements` per year. This is the catalog the
co-op should stand up for `2026-27`, based on the two templates already
backfilled in the code (`NOWgrVuBcr` handbook, `EmfQUgwGOC` liability waiver)
and standard homeschool-co-op practice.

| # | Form | `kind` | Scope | Signer(s) | Renewal | OpenSign template |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Family handbook acknowledgement | document | Per household | One parent/guardian | Every school year, **and** on any handbook revision | `NOWgrVuBcr` (backfilled) |
| 2 | Liability waiver & assumption of risk | document | Per household | Each parent/guardian on the account **ASSUMPTION** | Every school year | `EmfQUgwGOC` (backfilled) |
| 3 | Photo / media release | document | Per child **ASSUMPTION** | One parent/guardian | Every school year; opt-out allowed | *needs a template* |
| 4 | Medical / emergency care authorisation | document | Per child | One parent/guardian | Every school year | *needs a template* |
| 5 | Code of conduct (student + parent) | document | Per household | One parent/guardian | Every school year | *needs a template* |
| 6 | Field-trip / off-site permission | document | Per child, per trip | One parent/guardian | Per event (not annual) | *per-trip template or PDF* |
| 7 | Annual dues | dues | Per family + per child | n/a (payment) | Every school year | n/a |

Notes:

- **Per-child forms (3, 4, 6).** The schema attaches a `family_requirement` to a
  `family_id`, not a `child_id`. Today a per-child form is modelled as one
  household requirement covering all the family's children, or as separate
  requirements titled per child. A first-class per-child requirement is in the
  gap list (§9).
- **Field-trip permissions (6)** are event-scoped, not annual. Create a fresh
  `requirement` under the current year per trip, open it only to the enrolled
  families, and set `due_on` to the trip date so the reminder cron chases it.

## 3. Signers

**ASSUMPTION — Sam to confirm.**

- **One signature per household settles a household-scoped document.** Any
  active adult in the household may sign; the first completed signature marks
  the `family_requirement` complete. This is what the code does today
  (`CellEditor` sends to one adult; the OpenSign plan meters signatures, so
  sending to every adult would double the annual draw).
- **Exception — the liability waiver (form 2)** should arguably be signed by
  *each* legal guardian on the account. The current one-signer model does not
  express "both parents must sign". If the co-op's counsel wants per-guardian
  waivers, that is a real change (§9, gap 4).
- **Students do not sign.** Where a student acknowledgement is wanted (code of
  conduct), it is captured as part of the parent's signature / a checkbox in the
  form body, not as a separate OpenSign signer, because minors are not
  independent signing parties.
- **The co-op counter-signs nothing.** These are one-way acknowledgements from
  the family to the co-op.

## 4. Versions

### What "version" means here

A form's **version** is the exact document a family signed — its wording, its
signature-field layout, and the date that wording took effect. A family is
compliant only if they have signed the **current** version for the **current**
school year.

### How the current version is identified today

- The **school year** is the coarse version boundary. Rolling `is_current` to a
  new year makes every prior signature stop counting; families re-sign against
  that year's requirements.
- Within a year, the **OpenSign template** (`opensign_template_id`) is the
  single source of the live wording and field layout. Editing the template in
  OpenSign changes what new sends contain.
- The signed artefact is pinned: the completed PDF and OpenSign's completion
  certificate are copied into `family-village-private/signed/` at completion
  time (`opensign-sync` → `storeSignedCopy`). That copy is immutable evidence of
  exactly what that family agreed to, even if the template is edited afterward.

### The gap

There is **no explicit version number or effective date on a requirement**, and
**nothing detects that a template changed mid-year**. If the co-op revises the
handbook in October, families who signed in August still read as `complete`
against the same requirement, and no re-sign is triggered. See §9 gap 1 for the
proposed `version` / `version_effective_on` columns and the re-sign flow. Until
that lands, the operational rule is:

> **ASSUMPTION / policy:** mid-year form revisions are avoided. If a form must
> change mid-year, the admin deletes and recreates the requirement (or resets
> every family's cell to `outstanding`) and re-sends. This is deliberately
> heavy — it is meant to be rare.

## 5. Renewal rules

| Rule | Applies to | Mechanism |
| --- | --- | --- |
| **Annual** — re-sign every school year | Forms 1–5, dues | New `school_year` row → new `requirements` → `openToAllFamilies` creates fresh `outstanding` cells. Last year's signatures are untouched and retained, but no longer counted. |
| **On revision** — re-sign when the wording changes | Form 1 (handbook), any form counsel flags | Not automated today (§4 gap). Manual: reset cells + re-send. |
| **Per event** — sign once per occurrence | Form 6 (field trips) | One requirement per trip, `due_on` = trip date, opened only to enrolled families. |
| **One-time** — sign once, never expires | none currently | Would need a requirement with no `school_year` scoping; not modelled. If the co-op wants a truly one-time form, track it as a `document` on the household in Admin → Families rather than as a `requirement`. |

New-family onboarding mid-year: `openToAllFamilies` skips households that already
have a cell, so running it again after a family joins creates only their missing
cells. Dues `amount_due` is captured at cell-creation from the family's active
child count and is **not** re-derived on read; an admin runs **Recalculate
balances** on purpose.

## 6. Signature evidence and audit trail

For every completed signature the following is retained:

| Evidence | Where | Written by |
| --- | --- | --- |
| Signed PDF (all pages, signature blocks rendered) | `family-village-private/signed/<uuid>.pdf`, and a `documents` row `kind = 'signed'`, `family_id` set | `opensign-sync` `storeSignedCopy` |
| OpenSign completion certificate (signer identity, email, IP, timestamps, audit hash as OpenSign records it) | `family_requirements.certificate_url` | `opensign-sync` |
| Provider document id (ties the signature back to OpenSign's own record) | `family_requirements.provider_document_id`, `signature_requests.provider_document_id` | `opensign-send` |
| Who was asked, at what address, by which admin, and when | `signature_requests` (`signer_email`, `signer_name`, `requested_by_user_id`, `requested_at`) | `opensign-send` |
| Per-signer lifecycle timestamps | `signature_requests.status` transitions + `completed_at`; `updated_at` touched by trigger | webhook / sync |
| Completion time as the portal recorded it | `family_requirements.signed_at` | `opensign-sync`, or an admin via `CellEditor` "Mark signed" |
| Last time the portal reconciled with OpenSign | `family_requirements.last_synced_at` | `opensign-sync` |
| Admin actions on the record | `audit_log` (`signature_link_created`, `requirement_status_changed`, `requirement_opened`, `requirement_deleted`) | compliance tab |

### Timestamp semantics

- All timestamps are `timestamptz`, stored UTC.
- `signed_at` is **the time the portal marked the row complete**, which is when
  `opensign-sync` ran or when an admin clicked "Mark signed" — not necessarily
  the wall-clock moment the signer clicked *Finish* in OpenSign. The
  **authoritative** signing time for legal purposes is the one on OpenSign's
  completion certificate (`certificate_url`), which is why the certificate is
  copied and kept, not just linked.
- Date-only fields (`due_on`, `school_years.starts_on/ends_on`) are rendered in
  UTC on purpose (`lib/compliance.ts` `formatDate`) so a `2026-09-15` due date
  does not display as the 14th in Central Time.

### Known evidence gaps

1. **Public-link signatures carry no verified identity.** A `public_sign_url`
   signature has the signer type their own name and email; nothing ties it to a
   household, and an admin confirms completion manually in the matrix. Use
   per-family template sends for anything that has to be provable. This is
   already documented in `20260822185516_requirement_public_sign_url.sql`; it is
   repeated here because it is a legal-suitability point.
2. **The webhook path does not pull the signed PDF.** `opensign-webhook` only
   moves status. The signed artefact and certificate are fetched by
   `opensign-sync`. If the webhook is the only thing running, run a sync (or let
   the scheduled one run) to capture the evidence. Recommend: keep the scheduled
   sync enabled even after the webhook secret is set.
3. **Admin opening a signed PDF is not audit-logged.** `documents_read` lets any
   admin open any signed copy; there is no `audit_log` entry for the read. Low
   risk (admins are the record keepers) but worth noting for a review.
4. **`signed_by_user_id` exists on `family_requirements` but no code path ever
   sets it.** The identity of the signing adult is currently only recoverable
   from the OpenSign certificate and the `signature_requests.signer_email` on
   the send. See gap §9.6.

## 7. Exports

**Current state: no one-click export.** The data is all queryable. Two supported
ways to get it out today:

1. **Per family, per signature — the signed PDF + certificate.** From the family
   portal ("Download copy") or, for an admin, by opening the `documents` row /
   `certificate_url`. These two files *are* the exportable legal record for one
   signature.
2. **Whole-cohort status — SQL.** Run against the Supabase project (admin only):

   ```sql
   select f.display_name              as family,
          sy.label                    as school_year,
          r.title                     as requirement,
          r.kind,
          fr.status,
          fr.signed_at,
          fr.signed_by_user_id,
          fr.provider_document_id,
          fr.certificate_url,
          d.storage_path              as signed_pdf_path,
          fr.amount_due, fr.amount_paid, fr.paid_at,
          fr.last_synced_at
   from family_requirements fr
   join requirements  r  on r.id = fr.requirement_id
   join school_years  sy on sy.id = r.school_year_id
   join families      f  on f.id = fr.family_id
   left join documents d on d.id = fr.signed_document_id
   where sy.is_current
   order by f.display_name, r.sort_order;
   ```

3. **Per-send detail** — join `signature_requests` on `family_requirement_id`
   for who-was-asked-and-when.

**Recommended (gap §9, item 3):** an **Export CSV** button on the Compliance tab
that produces exactly query 2 for the selected year, plus a "Download all signed
PDFs (zip)" action, so an end-of-year archive is one click and does not require
database access. Retention/handoff to a board member is much likelier to
actually happen if it is a button.

## 8. Retention and deletion

**ASSUMPTION — Sam / counsel to set the actual periods.** Proposed policy:

| Record | Keep for | Rationale |
| --- | --- | --- |
| Signed PDFs + completion certificates | **7 years** after the end of the school year they cover | Liability waivers and medical authorisations may be relevant to claims that surface years later; 7y aligns with common US statute-of-limitations planning. Counsel to confirm for Texas. |
| `family_requirements` rows (status, timestamps, provider ids) | Same as the PDFs | They are the index into the evidence. |
| `signature_requests` rows | Same | Chain-of-custody for who was asked. |
| `audit_log` | Indefinite (it is small and append-only) | — |
| `compliance_reminder_log` | Prune after the school year closes | Operational only, no evidentiary value. |
| Unsigned / declined / expired requests | 1 year | Enough to answer "did we ask them?"; no need to keep indefinitely. |

Deletion behaviour to be aware of:

- Deleting a **requirement** cascade-deletes every `family_requirement` against
  it — signed waivers, payment records, all of it. This is why it is the one
  action behind a typed confirmation. **Do not delete a past year's
  requirements** to "tidy up"; that destroys the evidence. Archive by leaving
  them and rolling `is_current`.
- Deleting a **family** cascade-deletes their `family_requirements` and their
  `documents`. Before off-boarding a family whose records are still within the
  retention window, export their signed PDFs first (§7 item 1).
- Deleting a **`family_requirement`** sets `documents.signed_document_id` to
  `null` via `on delete set null` but does **not** delete the signed PDF row or
  the storage object — the artefact survives the index being removed. Good for
  evidence, but it means orphaned `documents` rows accumulate; a periodic
  reconcile is worth having.
- The signed PDF in storage is **not** deleted by any application code today.
  Removal at end-of-retention is a manual/scripted operation against the bucket.

A scheduled retention job (pg_cron, mirroring `send_compliance_reminders`) that
deletes storage objects + rows past the window is **recommended but not built**
— it should not be built until counsel signs off on the periods, because it
destroys records.

## 9. Gap analysis — recommended changes (NOT applied)

Proposed. None of this is in a migration file yet, on purpose — CI runs
`supabase db push` on every push to `main` and a half-baked migration would try
to apply against production. Land these deliberately, one reviewed migration at
a time, after Sam confirms the policy in §2–§8.

### Gap 1 — Form versioning + re-sign on revision *(highest value)*

```sql
-- PROPOSED, not applied.
alter table public.requirements
  add column version integer not null default 1,
  add column version_effective_on date;

alter table public.family_requirements
  add column signed_version integer;   -- the version that was current when signed

-- A family is out of compliance if signed_version < requirements.version.
-- The compliance panel and the admin matrix treat "signed an older version"
-- as outstanding-with-a-reason ("Handbook updated — please re-sign").
```

Admin flow: bumping `version` (with a new `version_effective_on` and, usually, a
new/edited OpenSign template) flips every `complete` cell whose `signed_version`
is now stale back to a `needs_resign` state and re-runs the send. `signed_at` /
the old signed PDF are kept as the record of the prior version.

### Gap 2 — Per-child document requirements

```sql
-- PROPOSED, not applied.
alter table public.family_requirements
  add column child_id uuid references public.children(id) on delete cascade;

-- Relax the uniqueness so a requirement can have one row per child:
alter table public.family_requirements drop constraint family_requirements_requirement_id_family_id_key;
create unique index family_requirements_req_family_child_uidx
  on public.family_requirements (requirement_id, family_id, coalesce(child_id, '00000000-0000-0000-0000-000000000000'));
```

Lets medical authorisation / photo release / field-trip permission be tracked
and signed once per child. `openToAllFamilies` fans out per active child when
`requirements.per_child_form = true`.

### Gap 3 — Export button + signed-PDF archive

Frontend only, no schema change. Add **Export CSV** (query in §7) and **Download
signed PDFs (zip)** to the Compliance toolbar. Gate on admin, log to
`audit_log` as `compliance_exported`.

### Gap 4 — Per-guardian waivers (only if counsel wants it)

Model as a `requirement.min_signers` (default 1). When `> 1`, the cell is
`complete` only once that many distinct `signature_requests` for the household
reach `signed`. `opensign-send` sends to each guardian; the plan's signature
draw goes up accordingly, so this is a cost decision too.

### Gap 5 — Retention job

pg_cron job deleting storage objects + rows past the retention window. Build
**after** §8 periods are confirmed by counsel.

### Gap 6 — Smaller items

- Audit-log admin reads of signed PDFs (evidence gap §6.3).
- Populate `signed_by_user_id` — on the admin "Mark signed" path (the acting
  admin is not the signer, so this needs an explicit "signed by" picker), and on
  the sync path by matching the completed signer email back to a household adult.
- Periodic reconcile for orphaned `kind = 'signed'` documents rows.
- Keep the scheduled `opensign-sync` on even after the webhook secret is set, so
  the signed PDF is always captured (evidence gap §6.2).

## 10. Legal-review checklist (before production use)

The AC requires the approach be "reviewed for legal suitability before
production use." That review is a **human/counsel step** and is not satisfied by
this document. Take the following to whoever reviews it (a lawyer familiar with
Texas homeschool co-ops / minors' liability waivers):

1. **E-signature validity.** Confirm OpenSign's process (typed/drawn signature +
   completion certificate with IP and timestamps) satisfies the US ESIGN Act and
   Texas UETA for these document types — in particular for **liability waivers
   involving minors** and **medical authorisations**, which some jurisdictions
   hold to a higher bar than ordinary contracts.
2. **Consent to do business electronically.** ESIGN requires the signer be told
   they may sign on paper instead and consent to electronic signing. Confirm
   OpenSign's flow presents this, or add an explicit consent checkbox to each
   template's first page.
3. **Identity assurance.** Per-family template sends go to a known household
   email; public-link signatures do not verify identity at all (§6 gap 1).
   Confirm the assurance level is acceptable per document type, and retire the
   public-link path for anything that must be enforceable.
4. **Who must sign.** Confirm one guardian per household is sufficient for each
   form, or specify which forms need every legal guardian (drives gap §9.4).
5. **Waiver wording.** The enforceability of a minor's-activity liability waiver
   turns almost entirely on its text (conspicuousness, express negligence
   language, scope). Counsel should review the actual template body in OpenSign,
   not just the process.
6. **Medical authorisation scope.** Confirm the medical form authorises what the
   co-op actually needs (emergency treatment, medication administration, allergy
   info handling) and names the right decision-makers.
7. **Retention periods (§8).** Confirm 7 years post-year-end for
   waivers/medical, and whether any record must be kept longer (e.g. until the
   youngest child reaches the age of majority + N years).
8. **Data handling.** Confirm storing signed PDFs and OpenSign certificates in
   the private Supabase bucket, accessible to co-op admins, meets the co-op's
   obligations for the child/medical data those forms contain. Cross-reference
   the project's overall child-data protection posture.
9. **Vendor.** Confirm OpenSign (data location — cloud vs EU vs self-host —
   subprocessor list, breach terms) is acceptable, and that the co-op has a
   signed DPA / terms with them if required.
10. **Revocation / correction.** Confirm the process for a family to withdraw a
    consent (e.g. photo release opt-out mid-year) and how that is recorded
    (today: admin sets the cell to `waived` with a note).

Record the outcome of this review (date, reviewer, conclusions, any required
template edits) in this file or alongside it before the first production send.

## 11. Operations runbook

### Secrets (Supabase Edge Function secrets)

| Secret | Needed for | Notes |
| --- | --- | --- |
| `OPENSIGN_API_TOKEN` | send + sync | Rotated in OpenSign under Settings → API Token. Probe without creating anything: `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/createdocument" -H "x-api-token: $TOKEN" -H 'Content-Type: application/json' -d '{}'` → `400` good, `405` rejected. |
| `OPENSIGN_WEBHOOK_SECRET` | webhook (instant path) | Until set, `opensign-webhook` returns 503 and refuses everything; polling still works. Order: create the webhook in OpenSign first (it only issues the signing key once a live URL exists), then set this to the `?token=` value you chose. |

`integration_settings.api_base_url` (Admin → Integrations) must end in
`/api/v1.2`.

### If either function is redeployed via the Supabase CLI or dashboard

Pass `--no-verify-jwt` (CLI) / uncheck "Enforce JWT verification" (dashboard).
This project signs sessions with an ES256 key that the platform JWT gate
rejects; all three functions do their own admin check and must run with
`verify_jwt = false`. Reverting silently breaks every real user (see HANDOFF).

### Routine checks

- **Admin → Compliance → Check for signatures** runs a sync on demand; the same
  function is scheduled. If "problems" are reported, the first one names the
  cause (usually a rotated token).
- The daily reminder cron (`send_compliance_reminders`, 13:00 UTC) notifies
  active adults 7 / 1 / 0 days before a requirement's `due_on`. In-app
  notification only today; email is a planned follow-up.

### Verifying a template send end to end

1. Admin → Compliance → attach `opensign_template_id` to the requirement.
2. Open it to all families.
3. Send to one test household.
4. Sign via the link on that family's dashboard.
5. Check for signatures → cell flips to `complete`, "Download copy" appears,
   `certificate_url` is populated.
