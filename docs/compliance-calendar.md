# Compliance calendar (administrators only)

Admin, Records, **Compliance** (`?tab=deadlines`). It lists the co-op's filing deadlines and renewals, tracks each one to "filed", and puts them on the calendar for administrators only.

This is a reminder list, not legal or tax advice. Rules marked **check** need confirming with the agency named. A tax professional should confirm what the co-op files.

## What administrators see

- **Upcoming**: everything open in the next 18 months, with a status (not started, in progress, filed, not needed this year), how many days are left, and a "Past due" group above it if anything was missed. Open a deadline to see what it is, the official page it comes from, and why the date moved if it fell on a weekend or holiday.
- **Mark as filed**: the date filed, the confirmation number, and an optional copy (PDF or photo). The copy goes into the records vault as a new record (category tax or nonprofit, tagged `compliance`), using the vault's own upload and logged-open steps. "Not needed this year" asks for a reason.
- **History**: past, filed and no-longer-applicable deadlines, grouped by year.
- **Add a deadline by hand**: for a grant report, a Secretary of State notice, a permit. You can choose whether the date moves off weekends and holidays, and the form shows where it would land.
- **Rules**: the full rules list below, with whether each one is on and when it is next due.
- **Settings**: fiscal year end, state, employees, contractors, usual size of gross receipts, the board meeting and handbook dates, and the optional items.
- **Calendar**: each deadline is an all-day event titled "Due: …", "Filed: …" or "Not needed: …". It shows in a muted sage colour with a dashed edge, along with the note "Only administrators see this event". News & calendar lists these events but sends edits to the Compliance page.
- **Reminders**: 60, 30 and 7 days before each open deadline, to every active administrator. They arrive in the bell and by push, with an email fallback if nobody opens them within the ladder's wait.

## Who sees what

| Place | Families and teachers | Administrators |
| --- | --- | --- |
| Calendar, Today | never (row-level security on `events`) | yes, after the second factor |
| Event reminders | never | yes |
| Deadline reminders | never | yes |
| Public and class calendar feeds | never | never |
| Personal calendar feed | never | yes (their own feed only, not a reviewer account) |
| Compliance tables and functions | refused | yes, with the admin role, the second factor, and not a reviewer account |

pgTAP `036_compliance_calendar.test.sql` checks each row of this table.

## The rules

They're kept in code: `private.compliance_rule_catalog()` in `supabase/migrations/20261121130100_compliance_calendar.sql`.

| Rule | Applies to | Date | Moves off weekends and holidays | Source |
| --- | --- | --- | --- | --- |
| IRS annual return (990-N, 990-EZ or 990), with Form 8868 extension noted | every 501(c)(3) | 15th day of the 5th month after the fiscal year ends | yes | [IRS due date](https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date) |
| Form 990-T (optional, off, **check**) | $1,000+ unrelated business income | same as the return | yes | [IRS Form 990-T](https://www.irs.gov/forms-pubs/about-form-990-t) |
| Forms 1099-NEC (and 1096 on paper) | co-ops that pay contractors | 31 January | yes | [IRS 1099-NEC instructions](https://www.irs.gov/instructions/i1099mec) |
| Form 941 | employees only | 30 Apr, 31 Jul, 31 Oct, 31 Jan | yes | [IRS Form 941](https://www.irs.gov/forms-pubs/about-form-941) |
| Forms W-2 and W-3 | employees only | 31 January | yes | [IRS Form W-2](https://www.irs.gov/forms-pubs/about-form-w-2) |
| Texas Workforce Commission wage report (optional, **check**) | employees only | last day of the month after each quarter | yes | [TWC unemployment tax](https://www.twc.texas.gov/businesses/unemployment-tax) |
| Texas franchise tax: confirm the exemption (optional, on, **check**) | Texas nonprofits without a confirmed exemption | 15 May | yes | [Texas Comptroller, 501(c)(3)](https://comptroller.texas.gov/taxes/exempt/501(c)-exemptions-1.php) |
| Texas SOS periodic report (**check**, never generated) | only when a notice arrives | 30 days after the notice | n/a | [Texas SOS](https://www.sos.state.tx.us/corp/nonprofit_org.shtml) |
| Renewals from the records vault | every vault record with an expiry date | the expiry date | no | the vault |
| Annual board meeting (optional, on, **check** bylaws) | co-ops whose bylaws call for one | set in settings (31 January) | no | [Texas BOC ch. 22](https://statutes.capitol.texas.gov/Docs/BO/htm/BO.22.htm) |
| Conflict-of-interest statements (optional, on) | good practice | same day as the board meeting | no | [IRS governance](https://www.irs.gov/pub/irs-tege/governance_practices.pdf) |
| Handbook and waiver refresh (optional, on) | co-op policy | set in settings (15 July) | no | none |

The 1099-NEC threshold is $600 for payments made through 2025 and $2,000 for payments made in 2026 (One Big Beautiful Bill Act). After 2026 the IRS adjusts it for inflation. Each 1099 deadline says which threshold applies.

**Roll-forward.** A due date on a Saturday, Sunday or legal holiday moves to the next business day (IRC 7503). Legal holidays here means the federal holidays, using the observed Friday or Monday, plus DC Emancipation Day (16 April), which the IRS also observes. Inauguration Day is left out. The same rule is used for the Texas dates. `lib/compliance-dates.ts` mirrors the SQL for the page's previews, and `lib/compliance-dates.test.ts` checks the same cases as the pgTAP file.

## How the deadlines are made

`private.sync_compliance_deadlines(today)` runs nightly at 13:00 UTC (pg_cron job `compliance-deadlines`). It also runs when the settings are saved and when a vault record's expiry, title or archive state changes. Each run does the following:

- It adds every occurrence the rules give for the next 18 months. The key is (rule, occurrence), for example `irs_annual_return` / `FY2026-12-31`, so a second run adds nothing.
- It updates an open occurrence whose title, details or date changed. Filed and "not needed" ones are left as they were.
- It deletes a future occurrence the rules no longer give, if nothing was recorded on it. If it was in progress, it's retired instead: kept in the history and taken off the calendar.
- It never touches past deadlines.

The run returns `{added, changed, removed, retired}`. The Refresh button on the page shows these counts.

`private.run_compliance_reminders(now)` sends each reminder on its day, or up to two days late if a run was missed, but only while no later reminder is already due. It skips a reminder whose day had already passed when the deadline was created. The log `compliance_deadline_reminder_log` makes repeat runs send nothing. Notifications have kind `compliance_deadline`, which is added to the email fallback list.

## What the owner fills in

1. **Settings**: fiscal year end (check the IRS determination letter or the last return), employees, contractors and usual size of gross receipts.
2. **Records vault key facts**: legal name, EIN, mailing address and principal officer (the year-end tax summary uses these).
3. **Records vault records with expiry dates**: the insurance policy and the church lease, so their renewals appear.
4. **The check items**: confirm the Texas franchise tax exemption with the Comptroller. Confirm with a tax professional whether the 990-T could ever apply.
