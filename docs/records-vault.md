# Records vault

The co-op's own paperwork: the insurance policy, the church lease, the IRS determination letter, state filings,
contracts and licenses, plus the co-op's key facts (legal name, EIN, address and so on). Administrators only.

Screen: Admin, Records, **Records vault** (`?tab=vault`), `app/family-village/admin/records-vault-tab.tsx`.
Database: `supabase/migrations/20261114110000_records_vault.sql`, tests in `supabase/tests/database/024_records.test.sql`.
Browser helpers: `lib/records-vault.ts`, tests in `tests/records-vault.test.mjs`.

## Who can use it

Everything goes through the vault's database functions, which call `private.require_records_admin()`: the admin
role, the second factor completed in this session, and not a reviewer (demo) account. Families and teachers cannot
read any of it. The screen hides nothing the database would allow; it only explains refusals before the round trip.

## Records

- **List**: active records by soonest expiry, with a chip for expired, expiring within 60 days, sensitive and
  archived. Search covers the title, issuer, reference number, notes and tags. "Archived" shows the archived ones.
- **Add**: title, category, issuer, reference number, amount, effective and expiry dates, keep-until date, tags,
  notes, sensitive, and optionally the first file. Nonprofit, tax and financial records start out marked sensitive.
- **Edit** needs a reason; each save is a new version in the history (`admin_update_record`).
- **Archive** needs a reason and can be undone with **Restore**. An archived record cannot be edited or given a file.
- **Erase** is the deliberate second step: the record must be archived, past its keep-until date if one is set,
  with a reason and the title typed back. The record, every file version and the change history are deleted; the
  activity log keeps one line (title, category, number of files, reason). The screen then removes the files from
  storage; the database grants the erasing administrator ten minutes on exactly those paths to do it.

How long to keep each kind of record is a question for the co-op's attorney or accountant. Nothing picks a number:
keep-until is blank unless someone sets it.

## Files

- **Upload**: the browser checks the type (PDF, JPG, PNG, WebP) and size (20 MB), works out the SHA-256, uploads to
  `records/<record id>/<file id>.<ext>` in the private bucket with `upsert: false`, then registers it with
  `admin_add_record_file`, which reads the real size and type back from storage. If registering fails the upload is
  removed again. A second or later version needs a note saying what changed. Nothing is ever overwritten; earlier
  versions stay in the list and can still be opened.
- **View** and **Download** call `admin_open_record_file` first, which writes `record_file_viewed` or
  `record_file_downloaded` to the activity log and opens a two-minute grant. The signed link (two minutes) is made
  inside that grant. Without the open step the storage policy refuses the read.

## History

Each record's History lists every saved version (from `org_record_revisions`, with the fields that changed and the
reason) and every file added, viewed or downloaded (from `audit_log`), newest first, with who did it.

## Key facts

The list comes from `admin_list_org_facts`, which masks sensitive values (the EIN, the insurance policy number) to
the last four characters. **Reveal** calls `admin_reveal_org_fact`, which writes `org_fact_revealed` to the activity
log; the value shows for a minute. **Edit** never pre-fills a sensitive value. After the first entry a change needs a
note, and **History** (`admin_org_fact_history`) shows earlier values, masked for sensitive facts. **Add a fact**
makes a custom one, optionally sensitive.

## Not done here

- The year-end tax summary (PR #156) has its own small key-facts editor; once both are merged it can link here.
- The compliance calendar (PR #155) files copies into the vault with its own `storeInVault`; it can switch to
  `uploadRecordFile` and `recordFileUrl` from `lib/records-vault.ts` after it merges.
- No in-page preview: View opens the file in a new tab.
