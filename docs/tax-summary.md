# Year-end tax summary (administrators only)

Admin, Money, **Year-end tax summary** (`?tab=tax-summary`). It gives the figures the IRS annual return asks about, taken from the portal's own records, plus the 990-N checklist and a PDF and CSV for the bookkeeper.

**This is a helper, not tax advice.** The page says so at the top, and again next to the form choice and in the export. The IRS rules decide which return applies, and a tax professional should confirm it.

## What it shows, for a chosen tax year

The year runs to the fiscal year end set in Admin, Compliance, Settings. "2026" means the year that ends in 2026. The IRS names a return by the year it begins, so the page also says which form year that is.

- **Money in and out**:
  - dues collected online (Stripe) and offline (cash, check, Crowded, other)
  - other income entered by hand (donations, fundraisers, grants)
  - gross receipts
  - refunds, shown separately
  - expenses by category
  - net
- **Other income**: add or void entries. Each one is in the audit log.
- **Which return probably applies**, with the arithmetic written out (`lib/tax-form-choice.ts`, unit-tested in `lib/tax-form-choice.test.ts`):
  - **990-N**: gross receipts normally $50,000 or less. For a co-op three or more years old, that's the average of this year and the two before. In the first year the limit is $75,000; in the second, it's a $60,000 average over the first two years.
  - **990-EZ**: gross receipts under $200,000 and total assets under $500,000 at year end.
  - **990**: otherwise.
  - Anything missing (a year's receipts, total assets, the first tax year) is listed as **Check**, never guessed.
- **Figures entered by hand**: gross receipts for years before the portal (the portal's own figure is still shown beside them), total assets at year end, and the co-op's first tax year.
- **990-N checklist**: legal name, EIN, mailing address, other names, website, principal officer's name and address, tax year, and whether receipts are within the limit. Each item is filled from the records vault key facts and marked Ready or Missing.
  - The EIN shows masked. "Reveal" calls `admin_reveal_org_fact`, which writes an audit entry, and shows the number for a minute.
  - The PDF and CSV always show the EIN masked.
  - The records vault has no screens yet, so **Fill in the key facts** (under the checklist) sets these through the vault's own `admin_set_org_fact`. Each change keeps its history and is logged. The EIN field there is write-only.
- **Payees who may need a 1099-NEC**: total expense payments per payee in the calendar year at or above that year's threshold. The threshold is $600 for payments made through 2025 and $2,000 for 2026; after 2026 the page says to check the inflation adjustment.
  - Payee names are grouped regardless of case and spacing.
  - The page explains who doesn't need one: employees, usually corporations, and anyone paid by card or a payment app.
  - It also says what to capture going forward: a W-9 for each contractor, kept in the vault, and how they were paid.
- **Export**: PDF and CSV, built from one report (`lib/tax-summary-doc.ts`) so they match the screen. Both include the not-advice note and the three-year rule.

## How payments are counted

- Payments count the same way as everywhere else in billing (`private.payment_counts`): real money only, or test-mode money while billing itself is in test mode. The page says so when that's the case.
- Reviewer (demo) families are always left out.
- Dates are read in Central Time.

## Security

- `admin_tax_summary`, `admin_add_other_income`, `admin_void_other_income` and `admin_set_tax_year_inputs` are SECURITY DEFINER with `search_path ''`. They are revoked from public and anon, and require the admin role, the second factor, and a non-reviewer account (`private.require_records_admin`).
- The new tables (`tax_other_income`, `tax_year_inputs`) can be read only by such administrators and written only through those functions.
- pgTAP `037_tax_summary.test.sql` covers access, the arithmetic, the demo and test-mode rules, the fiscal year, the payee threshold and the masked EIN.

## What the owner fills in

1. Admin, Compliance, Settings: the **fiscal year end**.
2. Key facts (here, under the checklist, or in the records vault): **legal name** (exactly as on the IRS letter), **EIN**, **mailing address**, **website** if any, **principal officer's name and address**, and **first tax year**.
3. Here: **other income** for the year, **total assets** at year end, and **gross receipts for years before the portal**.
