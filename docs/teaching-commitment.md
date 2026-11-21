# Teaching commitment tracker

Issue #151 (from the handbook map, #128). Admin, Classes, **Teaching commitment**. Admin-only.

The handbook asks every family for one adult to teach one class and assist in at least two each co-op day; a hall
monitor checks that children are in class. Admins tracked this in a spreadsheet. This screen replaces it.

**Words.** The spreadsheet's "Block" is the portal's **term** (`academic_terms`, four a year). The portal's
`class_blocks` are the class **periods** (History, Science, two electives).

## What admins see

For the chosen school year, one row per adult: for each term, **Taught**, **Assisted** and **Hall monitor** (T, A, H);
then the year's totals per role, **Total roles**, **Blocks** (terms with any role) and **Notes / classes covered** (the
admins' note, then the classes and hall periods from the portal).

- **By household** (the default): each household with its adults and a **household total** row. A term where the
  household is below the expectation is shaded, with what it still needs ("teach 1 more, assist 1 more").
  Teachers with no household and names kept from the spreadsheet are listed at the end.
- **Everyone**: one list, sorted by total roles.
- Filters: households below the expectation, adults carrying a lot; find by name; sort most first, fewest first or by name.
- A cell changed by hand or imported has a dashed outline and an asterisk. Selecting any cell shows where its count
  comes from, its history and a form to change it.
- **Download PDF** (landscape) and **Export CSV** use the report pipeline (`lib/report-doc.ts`, `lib/report-pdf.ts`)
  and export what is on screen.

The table scrolls inside its own box on a phone; the name column and the header stay in view.

## How a cell is counted

For one adult, one term and one role (`private.commitment_cells`):

- **Taught**: the periods in which they are the lead teacher of a class that runs that term. **Assisted**: the same for
  assistant assignments. A class runs in the terms it is linked to (`class_terms`); a class with no links runs all year.
  A class with no period counts on its own. Inactive classes of the year still count (they ran).
- **Hall monitor**: the periods they are assigned as hall monitor that term (`hall_monitor_assignments`, set in the
  Hall monitors card on this screen).
- **Value** = (a "set" count, if there is one, otherwise the automatic count) + the sum of adjustments, never below 0.

Reviewer (demo) accounts, demo classes and households with a reviewer in them never appear. Households marked not
returning for the year are left out.

**The check.** Per household and term: taught at least the teach target, and assisted (plus hall monitor, if the
setting says so) at least the assist target. A term is checked once it has started or anyone has a role in it, so
future terms do not flag everyone before planning starts. Settings (Expectation and settings card): teach target
(default 1), assist target (default 2), whether hall monitor counts as assisting (default yes), and the "carrying a lot"
mark (default 4 roles in one term, that is every period of the day).

## Changing a count

Every change is an entry in `teaching_commitment_entries`, always with a reason:

- **Add or take away** (`adjust`): a substitution, or work done outside the portal.
- **Set the count** (`set`): replaces the automatic count. The import writes these. A new set replaces the old one.

Entries are never edited or deleted; an admin removes one with a reason, and it stays in the history. Each change is
also in Admin, Activity. Notes are per person per year (`teaching_commitment_notes`).

**Hook for substitutes (#129).** When substitute requests are built, record coverage with
`private.record_commitment_entry(actor, term, user, null, role, 'adjust', +1 or -1, reason, 'substitute', request_id)`:
+1 for the person covering, -1 for the person absent. They show as "From a substitution" in the cell's history.

## Importing this year's spreadsheet

1. In Google Sheets, File, Download, Comma-separated values (or Save As CSV in Excel).
2. Admin, Classes, Teaching commitment, **Import the spreadsheet**, choose the file.
3. The layout must be the spreadsheet's: title rows, then a two-row header (Name, then Block 1 to Block 4 with Taught,
   Assisted, Hall Monitor beneath each), then totals columns and Notes. Blank rows, rows of zeros and a totals row are
   ignored; the sheet's Total roles is checked against the blocks.
4. Choose which term each Block is (by default, in order), or "Not imported" for a block.
5. For each name: the matching account (chosen for you only when exactly one account clearly matches; "Check this
   match" marks a looser match), **Keep as a name only** for someone with no account, or **Skip**. Every name needs a
   choice before saving.
6. Save. For the chosen terms, each person's three counts are saved as "set" entries, which replace what the portal
   would count from assignments; the Notes column becomes the person's note. A name kept as text can be linked to an
   account later (select the name); its counts move over.

The parser is `parseCommitmentSheet` in `lib/teaching-commitment.ts`; the database skips blank and zero rows again.

## Code and tests

- Migration `supabase/migrations/20261121090000_teaching_commitment.sql`: tables, RLS (administrators who are not
  reviewers and have used their second factor), `admin_teaching_commitment` and the write functions.
- `lib/teaching-commitment.ts`: types, CSV parser, name matching, report document. Tests:
  `lib/teaching-commitment.test.ts` (Deno, in CI's edge-function-tests).
- Screens: `app/family-village/admin/commitment-tab.tsx`, `commitment-import.tsx`, `commitment-setup.tsx`; styles in
  `app/teaching-commitment.css`.
- pgTAP: `supabase/tests/database/036_teaching_commitment.test.sql`.
- The Class roster report fills its hall monitor fields from the stored assignments for the chosen block.
