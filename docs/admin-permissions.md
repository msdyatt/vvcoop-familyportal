# Admin permissions

Two kinds of administrator, and five permissions that only the board has unless the board gives one out.

## Tiers

| Tier | Who | Default |
| --- | --- | --- |
| Board admin | Board members | All five permissions |
| Admin | Day-to-day helpers | None of the five. Everything else in Admin (families, invitations, classes, enrollment, messages, news and calendar, broadcasts, documents, dues ledger and payments, expenses, reports, appearance) works as before. |

An admin with no tier row is an Admin. When this shipped, every existing admin was made a board admin, so nobody lost access. The board decides who to move.

## The five permissions

| Permission | Key | Covers |
| --- | --- | --- |
| Integrations | `integrations` | Stripe mode (off, test, live) and clearing Stripe test data; connecting or disconnecting the office inbox and its Google setup (client ID and secret); the settings cards on Admin, Integrations (Resend From address, printer, Facebook link); the app store reviewer accounts. |
| School year setup | `year_setup` | Start the next school year (preview, run, which families return); adding, editing or deleting school years and terms, and setting the current year; enrollment windows. |
| Dues and fees | `dues_settings` | Dues amounts (dues requirements); monthly plan options; discount types; reminder, retry and receipt settings. |
| Tax and compliance records | `tax_compliance` | The records vault (records, files, key facts), the compliance calendar settings and deadlines, and the year-end tax summary. Reading as well as changing. |
| Admin permissions | `manage_permissions` | Tiers and these switches; adding or removing the admin role; suspending, reactivating or deleting another admin's account. |

A board admin can turn any of the five on or off for any admin, on top of the tier. A switch set back to the tier's default is stored as "no change", so it follows the tier from then on.

Still open to every admin on purpose: opening dues for families, per-family dues work (offline payments, discounts on a charge, adjustments, plans, refunds through approvals), grade placement, meeting times and rooms, the office inbox itself, notification and event-reminder settings, test emails and print jobs.

## Where it is enforced

The database is the lock; the screens only say so first.

- `private.require_admin_permission(key)`: every gated function calls it. It keeps the existing checks (admin role, active, not a reviewer account, second factor when the person has one) and adds the permission. The refusal reads `Ask a board admin. This needs the "<label>" permission.`
- `private.require_records_admin()` (records vault, compliance calendar, tax summary) and `private.require_rollover_admin()` (rollover functions) now call it, so every function behind them is gated. Grade placement moved to `private.require_placement_admin()` and stays day-to-day.
- Dues, billing and Stripe-mode functions, the office inbox connect steps and `office_inbox_save_setup`, call it directly.
- Restrictive RLS policies stop direct writes to `school_years`, `academic_terms`, `enrollment_periods`, dues rows in `requirements`, `integration_settings` and admin rows in `user_roles`, and stop reads of the vault, tax and compliance tables and `records/` files.
- Edge Functions: `office-inbox-oauth` (start, disconnect), `demo-accounts`, and `delete-account` (when the account is an admin's) ask `public.admin_has_permission(user, key)`, which only the service role can call. Shared helper: `supabase/functions/_shared/admin-permissions.ts`.
- Screens use `lib/admin-access.ts` (`useAdminAccess()`, from `public.my_admin_access()`) and `app/family-village/admin/ask-board-admin.tsx`.

## Lockout guard

At least one active board admin must always hold Admin permissions. A change that would leave none is refused: a tier change, a switch, removing the admin role, suspending or deleting the account, a reviewer flag, and doing any of those to yourself. Triggers on `user_roles`, `profiles`, `admin_tiers` and `admin_permission_overrides` check it, so it holds for the service role and SQL too. An Admin given Admin permissions can manage, but does not count towards the guard.

## Log

`public.admin_permission_audit` records who changed what and when: seeded, admin added, admin removed, tier changed, permission granted, revoked, or set back to the default. It is append-only, keeps no names (they are looked up when read, so an erased account shows as "Deleted account"), and is readable by board admins. Admin, Settings, Admin permissions shows the last 200.

## Tables and functions

- `public.admin_tiers` (user, `board` or `admin`), `public.admin_permission_overrides` (user, permission, on or off), `public.admin_permission_audit`. No direct writes from the browser.
- `public.my_admin_access()`, `public.admin_permissions_overview()`, `public.admin_set_admin_tier(user, tier)`, `public.admin_set_admin_permission(user, permission, on)`.
- Migration `supabase/migrations/20261121160000_admin_permissions.sql`; tests `supabase/tests/database/039_admin_permissions.test.sql`.

## Adding a new board-only area later

1. Add the key to `private.admin_permission_catalog()` and the check constraint on `admin_permission_overrides`, in a new migration.
2. Call `private.require_admin_permission('<key>')` at the top of each function, and add restrictive policies for any table the browser writes.
3. Add the label to `lib/admin-access.ts` and `_shared/admin-permissions.ts`, hide the controls with `useAdminAccess()`, and add refusal tests.
