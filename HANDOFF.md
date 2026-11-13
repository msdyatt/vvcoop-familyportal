# Veritas Village Family Portal: handoff

Last updated 13 Nov 2026. Read this first, then the docs it points to. The older, longer notes (August to early November) are kept in [docs/handoff-archive-2026-08.md](docs/handoff-archive-2026-08.md); parts of that file are out of date, but it still holds useful detail on traps and decisions.

## 1. What this is

A private, invitation-only portal for Veritas Village, a homeschool co-op (a 501(c)(3)). Parents, teachers and a few administrators use it for messages, classes, calendar, photos, signed documents and dues. Nothing is public except the marketing pages and sign-in.

It ships as:

- **Website** on a Cloudflare Worker (production domain `family.veritasvillage.org`).
- **Installed web app (PWA)** from the same site.
- **Native iPhone app**: a Swift "frame" (tab bar, navigation bar, Messages list, sheets) around the same site. See `docs/native-ios-frame.md`.
- **Android**: a Capacitor shell around the site (`mobile/android`). Not in the stores yet.

The app is mostly a thin web client that talks directly to Supabase with `@supabase/supabase-js`. There is no custom API server. Access control is Row Level Security plus `SECURITY DEFINER` functions.

Real families are **not** using it yet. A small test group may start in a later season. The owner is the co-op administrator; "the owner" below means that person.

## 2. Rules of engagement (do not break these)

1. **Production changes go through merged pull requests only.** CI deploys on every push to `main`. Do not run ad hoc deploys, direct database edits or one-off SQL against production.
2. **Merge only when the owner says "merge"** for that PR.
3. **Never put secrets in the repo, in chat or in logs.** Keys live in Supabase Vault, Supabase function secrets, Cloudflare Worker secrets and GitHub Actions secrets. Never commit the Apple push key, a Firebase service account, Stripe keys or the site password.
4. **Never sign in to production, create accounts there, or use real family data in tests.** Use local or test data.
5. **Children's information is sensitive.** Do not add anything that exposes one family's data to another. Test RLS changes with pgTAP.
6. **Test builds go on the owner's phone only**, never on anyone else's device, even if it shows up in device lists.
7. **Do not work around a permission denial.** Ask.
8. Keep prose plain. No marketing tone in UI copy.

## 3. Stack and layout

- Node `>=22.13.0`, React 19, vinext (a Next-style framework on Vite) built for a Cloudflare Worker. Plain CSS (no Tailwind utilities; only preflight is imported and it is load-bearing).
- Supabase: Postgres, Auth, Storage, Realtime, Edge Functions (Deno), pg_cron, pg_net, Vault. Project ref `jtwemgyhxylbhjzxgyvh`.

| Path | What is there |
| --- | --- |
| `app/` | Pages. Signed-in app is under `app/family-village/**` (home, messages, calendar, photos, classes, documents, dues, admin, teacher). Public pages at the root. |
| `app/globals.css`, `app/platform.css` | Styles. Colours are role tokens (see Theming). `platform.css` holds the iOS and Android approximations. |
| `lib/` | Shared logic: `supabase.ts`, `nav-prefs.ts`, `platform.ts`, `native-frame.ts`, `calendar.ts`, `messages.ts`, `storage.ts`, `report-doc.ts`, `schedule.ts`, theme helpers. |
| `worker/` | Cloudflare Worker entry: security headers, shared-password gate, calendar-feed pass-through, app-site-association file. |
| `supabase/migrations/` | Every schema change. `supabase/tests/database/` pgTAP tests. `supabase/functions/` Edge Functions and `_shared/`. `supabase/ci-bootstrap/` CI-only stand-ins (never apply to production). |
| `mobile/ios`, `mobile/android` | Native shells. iOS is built locally in Xcode (see `docs/native-ios-frame.md`). |
| `tests/` | Node tests run by `npm test`. |
| `docs/` | Feature and setup docs. Start with the index in section 6. |
| `public/` | Static files, `brand/` logos, vendored PDF libraries. |

## 4. Run, check, deploy

```
NODE_ENV=development npm ci
NODE_ENV=development npm run dev          # local dev server
NODE_ENV=development npm run lint
NODE_ENV=development npm run typecheck    # tsc --noEmit
NODE_ENV=development npm test             # builds, then runs node tests
```

Always prefix with `NODE_ENV=development`: some shells on the owner's Mac export `NODE_ENV=production`, which makes npm skip dev dependencies. Local ESLint and `tsc` can hang on this machine; CI is the authority.

Edge function tests: `cd supabase/functions && deno test --node-modules-dir=none --config invite-family-admin/deno.json _shared/ calendar-feed/` (plus the other function test files; CI lists them).

Database tests are pgTAP files in `supabase/tests/database/` (numbered; use the next free number). CI runs them against a fresh local Supabase in Docker with every migration replayed. There is no Docker on the owner's Mac yet, so locally you can replay migrations into an in-memory Postgres (PGlite) with stand-ins for Supabase's schemas. That is a close approximation; CI's `database-tests` is the real run.

**CI** (`.github/workflows/ci.yml`) runs on PRs to `main` and on pushes to `main`:

- `build-lint-test`, `edge-function-tests`, `database-tests` on every PR.
- On push to `main` only: `deploy` (Cloudflare Worker), `supabase-functions` (deploy all functions), `supabase-migrations` (`supabase db push`).
- `mobile.yml` builds the Android debug app when `mobile/**` changes.
- Pinned versions: Node 22.13.0, Deno 2.8.2, Supabase CLI 2.122.1.

If `supabase-migrations` fails because another merge landed a newer migration first, re-run the job on the latest `main`; `db push` then applies everything pending.

Manual deploy is a fallback only, with the owner's say: `npm run build` then `NODE_ENV=development npx wrangler deploy --config dist/server/wrangler.json --name veritas-village dist/server/index.js`.

Verify something is really live: `curl -s -o /dev/null -w "%{http_code}\n" https://family.veritasvillage.org/family-village` and `npx wrangler secret list --name veritas-village` (confirm the site password secrets survived).

## 5. Database and security rules

- Every schema or policy change is a migration file. **The filename timestamp must sort after the latest migration on `main`** and must match what `db push` records (exact version number). Two PRs that add migrations at once can race; rebase and renumber.
- Writes go through `SECURITY DEFINER` functions with `set search_path to ''`, schema-qualified names, `revoke ... from public, anon`, then `grant execute ... to authenticated`. A function with no ACL is executable by `PUBLIC` and becomes callable at `/rest/v1/rpc/<name>`; the Supabase API is **not** behind the Cloudflare password gate.
- A new table needs RLS **and** a `GRANT`; privileges are checked before RLS.
- Admin functions check the admin role and the second-factor level (`aal_satisfied`) and exclude demo accounts.
- Append-only tables (e-sign events, audit logs) block UPDATE and DELETE by trigger and revoked privileges.
- Three CI bootstrap objects were created by hand early on and are not in any migration; CI stubs them from `supabase/ci-bootstrap/`.
- Reviewer/demo accounts (`is_demo`) live in a sealed sample world. Exclude them from every audience, notification and report. Admin creates them from Admin, Integrations.
- The site sits behind a shared-password gate (`worker/site-password.ts`) ahead of the app router, fail-closed. Exempt on purpose: sign-in, the calendar feed route, and the Apple app-site-association file. Keep the gate until the owner says remove it. Test locally with throwaway values in `.dev.vars` (gitignored).

## 6. Feature map and where the docs are

| Area | Notes | Docs |
| --- | --- | --- |
| One portal | Family and Teaching share one bar and a flat Menu. Teaching items show when the person is assigned to a class this year. Admin stays separate (navy header). `lib/nav-prefs.ts`, `app/family-village/app-tab-bar.tsx`. | |
| Messaging | Direct, group, class and channel conversations; system channels #Announcements, #General and admin-only #Reports; reactions, replies, mentions, edits, multi-photo/file messages, "Seen by"; "Message parents" and "Message <teacher>" buttons start one thread per child and teacher with both parents; reports post to #Reports. Native iPhone Messages screens. | `docs/messaging-look-and-feel`, `messaging-phase2`, `messaging-phase3`, `announcement-cards.md` |
| Notifications | `notifications` table, push (Firebase, web push), email, optional text. Ladder: push first; email if unseen after a wait or no push; text only with recorded consent. Urgent broadcasts (admin screen, "Got it" banner, time-sensitive iOS push). Scheduled announcements. Event reminders 3 days and 1 day before at 9:00 AM Central. | `docs/notification-ladder.md`, `broadcasts.md`, `scheduled-announcements.md`, `event-reminders.md`, `native-push-setup.md` |
| Calendar | Month, week, day, list. Subscription links on the co-op domain through a Worker route that passes through to the `calendar-feed` function (`worker/calendar-feed.ts`, `lib/calendar-links.ts`). Co-op time zone America/Chicago; all-day events are stored at UTC midnight and class dates at midday UTC, so always convert through `lib/calendar.ts` helpers. | |
| Classes | Class pages for teachers and enrolled parents with a document repository (handouts for families, curriculum for teachers). Grade-based placement for History and Science. "Start next school year" wizard (Admin, Classes, Schedule & enrollment settings) with a returning-families choice. School years, terms, blocks, rooms and enrollment windows. | |
| Documents and signing | In-house signing with sealed PDFs, audit trail and an RFC 3161 timestamp. Forms and dues live on one Documents page. | `docs/esign-timestamp-verification.md` |
| Dues and Stripe | Stripe checkout and plans (card, bank, Apple Pay, Google Pay), receipts, expenses. Billing is test-mode until the owner finishes Stripe setup. The co-op banks with Crowded; Stripe pays out to the linked bank account. | `docs/stripe-dues-implementation.md`, `stripe-setup-checklist.md`, `native-apple-pay-setup.md` |
| Admin | Reports (screen, CSV, PDF), activity log, families, invitations, classes, news and calendar, broadcasts, integrations. The admin home page does not list everything yet (issue #107). | |
| Records vault | Database tables and storage policies for insurance, leases, nonprofit and tax records exist. There are no screens yet. | |
| Theming | Light, Dark or System, switched in Account Settings and the Menu. Components use role tokens, never raw brand colours. A test checks token contrast. | `docs/theming.md` |
| Native apps | iPhone: Swift frame, native bars, passkeys, share sheet, Face ID lock, push, Apple Pay. Android: Capacitor shell. | `docs/native-ios-frame.md`, `docs/store-readiness-review.md`, `docs/app-review-notes.md` |

Brand: Ink Navy `#0b2a3d`, Parchment Cream `#faf7f1`, Terracotta `#bb6141` (accent only), Hill Sage `#6f7d72`, Antique Gold `#aa7d38`. Playfair Display for headings, Inter for UI. The logo is a hand-engraved quill in an inkwell with "Veritas Village"; use the supplied files in `public/brand/` and never redraw or recolour it.

## 7. Accounts and services (no credentials here)

GitHub (this repo), Cloudflare (Worker and DNS), Supabase (database, auth, storage, functions), Stripe, Apple Developer (bundle id `org.veritasvillage.family`; push, Apple Pay and Time Sensitive Notifications capabilities), Firebase (push for iPhone and Android), Resend (outgoing email; the From address is set in Admin, Integrations), Google Workspace (staff addresses; a shared office inbox is planned), Crowded (the co-op's bank). A texting provider is not chosen yet.

Secrets are set in each provider's dashboard, in Supabase Vault (for example the Firebase service account) or in GitHub Actions secrets. If something needs a key, ask the owner to set it; do not ask for it in chat.

## 8. State of play

All features above are merged and deployed unless a section says otherwise. There are no open pull requests. Planned and open work is tracked in GitHub issues; start with the roadmap, issue #122, which links the rest (admin home, layout pass, edit dues, whimsy and seasonal logos, PWA bottom bar, shared office inbox, Stripe payouts, texting research, staging site, verification checklist, store readiness).

Known open problems:

- The installed web app's bottom bar is reported missing on the owner's device and was not reproduced (issue #111).
- The owner is documenting visual bugs in the apps (issue #115).
- Push, time-sensitive alerts and email have not been verified end to end on a real device (issue #117).

## 9. Gotchas

- **Stray files named like `... 2.xml` or `... 2.sql`** appear in the local folder when it is synced by iCloud. They are untracked artifacts. Do not commit them. Better: keep the working copy outside iCloud-synced folders.
- **A stray git ref `origin/main 2`** can make `git fetch` fail or hang; use `git ls-remote origin refs/heads/main` to get main's commit.
- **`globals.css` and `platform.css`** are very large and many branches append to the end, so they conflict often. Rebase on `origin/main`, rebuild the conflict from main plus your own block, and check that braces balance.
- **Stacked PRs** that target a non-`main` base do not start CI. Open each PR against `main`, one at a time.
- **GitHub Actions minutes:** the repo is private, so CI draws on a monthly allowance. Check Settings, Billing if checks stop starting.
- **Server and client date formatting differ.** Use the pinned helpers (`formatDate`, `formatMoney`) to avoid hydration mismatches and day-early dates in Central Time.
- **Migrations do not remove deployed edge functions.** Deleting a function folder does not delete it from Supabase.

## 10. Making a change (checklist)

1. Read the current file before editing it. Do not trust memory.
2. Branch from the latest `main`. Keep the PR small and about one thing.
3. Schema or policy change: write the migration, add or extend pgTAP tests, and test refusal cases (a wrong person must be refused).
4. Use role tokens for colour (`docs/theming.md`). Check light and dark.
5. Run lint, typecheck and `npm test`. Wait for green CI.
6. Describe in the PR what changed, why, and how to try it with test accounts. Say what you did not do.
7. Wait for the owner to say "merge". After merge, confirm the deploy run finished, including `supabase-migrations`.
