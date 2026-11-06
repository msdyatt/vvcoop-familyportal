# Veritas Village Family Portal — Project Handoff

## 25 Aug 2026 feature pass — built and verified locally, not yet released

The current working tree contains a coordinated public-site and portal update responding to Sam's 25 Aug feedback. It is intentionally **not described as live yet**: the two database migrations below have been applied to Supabase, but the Cloudflare site bundle and the updated `invite-family-admin` Edge Function still require an explicit production release.

- Public/login: horizontal hero lockup, public news section, reduced Friday-specific copy, email/password-only sign-in, repaired home link, and removal of the login sidebar.
- Shared UI: signed-in account photo with a gold detail, browser-based crop/zoom before upload, lighter motion cues, and permission-aware portal navigation without the old “Workspace” label.
- Admin: persistent left navigation, combined **News & calendar** editor, safe formatted news, system-wide events, printable Reports, class/family readiness filters, grouped CSV payment matching, and editable schedule settings nested under Classes.
- Scheduling: weekdays on time blocks, editable rooms, date-bounded academic terms, and many-to-many class-to-term assignment. Schema is recorded in `20260825050325_portal_schedule_terms.sql` and is already live.
- Family/teacher: descriptive elective enrollment cards, per-child and bulk assignment completion, teacher month calendar, family handouts versus teacher-only curriculum files, and a file-backed print queue. The curriculum privacy tightening in `20260825051802_protect_teacher_curriculum_files.sql` is already live.
- Verification: lint has zero errors (two existing `<img>` optimization warnings), the production build succeeds, focused rendered-page tests pass, the public home/login/preview fit a 390px viewport without overflow, and the formatted-news allow-list rejects scripts, event attributes, and unsafe links.

Release boundary: `supabase/functions/invite-family-admin/index.ts` now points invitations to `family.veritasvillage.org`, but that function version has **not** been deployed. Deploying it can create real household invitations and send real mail, so do so only after Sam explicitly confirms the production release. The same confirmation should cover the Cloudflare deployment; keep the shared-password gate and verify both Worker secrets afterward.

## What this is
A private family-portal web app for Veritas Village, a Central Texas homeschool co-op. It sits alongside the co-op's public marketing site in the same repo. Three private workspaces: **Family** (parents), **Teacher's Lounge** (teachers), **Admin** (co-op leadership).

## Stack & where things live
- **Framework**: A Next.js-style app using "vinext" (`@openai/sites-vite-plugin`), built with Vite, deployed as a **Cloudflare Worker**.
- **Repo**: `https://github.com/msdyatt/vvcoop-familyportal`, local clone at `/Users/samdyatt/Documents/Projects/vvcoop-familyportal` on this Mac.
- **Backend**: Supabase (Postgres + Auth + Storage). Project ref `jtwemgyhxylbhjzxgyvh`. All access control is via **Row Level Security (RLS)** — the app is a thin client talking directly to Supabase from the browser (`@supabase/supabase-js`), no custom API server.
- **Hosting**: Cloudflare Worker named `veritas-village`. Real production domain is **`family.veritasvillage.org`** (a separate custom domain from the public marketing site at `veritasvillage.org` — same worker, different route). Always test/verify against `family.veritasvillage.org`, not the `workers.dev` URL — WebAuthn/passkey RP ID is locked to the real domain and will fail on `workers.dev`.
- **App routes**: `/family-village` (sign-in), `/family-village/home` (Family), `/family-village/teacher` (Teacher's Lounge), `/family-village/admin` (Admin). Public marketing pages live at the site root (`app/page.tsx`, etc.) — separate from the private app.

## Important environment quirk
This Mac's shell has been seen with `NODE_ENV=production` set, which makes plain `npm install`/`npm ci` skip devDependencies (ESLint, TypeScript, Vite, wrangler, etc. all vanish). It is **not** set in `.zshrc`, `.zprofile`, `/etc/zprofile` or `/etc/zshrc`, and it was empty in a later session's shell — so it is probably exported ad hoc in some terminals and not others. **Keep prefixing build/lint/install commands with `NODE_ENV=development` regardless**: it is free when the variable is unset and essential when it isn't.
```
NODE_ENV=development npm run build
NODE_ENV=development npx eslint <files>
NODE_ENV=development npx wrangler deploy --config dist/server/wrangler.json --name veritas-village dist/server/index.js
```

## The site is password protected -- keep it that way
The public site sits behind a shared password enforced in `worker/site-password.ts`,
ahead of the app router so no route can bypass it. **Sam has asked that this stay on
until he explicitly asks for it to be removed.**

It reads the `SITE_PASSWORD` and `SITE_AUTH_SECRET` worker secrets and **fails closed** --
missing either one returns 503 rather than serving publicly. `/family-village` is exempt
because it has its own Supabase auth; gating it too would mean two credentials for one
household.

History worth knowing: those secrets existed on the worker for a long time while *nothing
in the repo read them*. The gate lived only in an uncommitted deployed build, so the first
`wrangler deploy` from this repo silently replaced it and the site went public. That is why
it is in version control now. Do not "simplify" the guard call out of `worker/index.ts`.

To test locally, put throwaway values in `.dev.vars` (gitignored) -- never the real password.

## Deploy command (exact)
```
npm run build
NODE_ENV=development npx wrangler deploy --config dist/server/wrangler.json --name veritas-village dist/server/index.js
```
`wrangler.json` in `dist/server/` is auto-generated by the build and defaults to a placeholder project name — the `--name veritas-village` override is what makes it hit the real worker. There is **no CI/CD** — every deploy is this manual command.

## Working conventions established this session
1. **Skim relevant SKILL.md files** before big frontend work if any exist for this stack.
2. **Always view the current file before editing it** — don't trust memory of prior state.
3. **Lint + full `npm run build` before every commit.** Both must be clean.
4. **Supabase migrations**: every schema/RLS change goes through `supabase/migrations/<timestamp>_<name>.sql`, applied live via the Supabase MCP/CLI *and* committed to the repo so history matches reality. (Earlier in this project some hand-run changes weren't captured in migrations and the history drifted — don't repeat that.)
5. **Never guess at existing schema/RLS** — query `information_schema.columns` and `pg_policies` before writing a migration that touches a table you haven't already inspected this session.
6. **Git identity on this Mac**: commits use `Codex <codex@veritasvillage.com>` (matches the existing commit history from the AI agent that built the original site) — already configured locally, no action needed.
7. **Commit messages**: multi-line, explaining *why* not just *what*, especially for RLS changes (state what was previously possible/impossible and what the policy now allows).
8. **Design system**: plain CSS in `app/globals.css`, now formatted one declaration per line (it was 44KB minified onto 80 lines). Tokens live in the `:root` block at the top and **no literal hex belongs anywhere else** — if you need a colour, add or reuse a token.
   - Palette is the **2026 Edition**: Ink Navy `#0B2A3D`, Parchment Cream `#FAF7F1`, Terracotta `#BB6141`, plus Hill Sage `#6F7D72` retained by Sam's choice. Morning Mist is gone.
   - **Small text must use `--terracotta-text` / `--sage-text`**, not the raw brand colours — the brand hues are only ~4.0:1 on cream and fail AA below 18.66px bold.
   - Headings are Playfair Display, UI text is Inter. The guide forbids the display serif for body, captions, labels, or anything under ~20px.
   - Each portal sets `--portal-accent` / `--portal-band-*` on its root class (`.live-portal`, `.workspace-preview`, `.admin-live`). Add new accented styling by consuming those vars, not by hardcoding terracotta.
   - **News attachments** live in `post_attachments`, not on `posts` -- `image_storage_path`, `attachment_url` and `video_url` were dropped. Render them with `PostAttachments` / `PostThumbnail` / `usePostAttachments` from `app/family-village/post-attachments.tsx` rather than signing URLs by hand; the bucket is private so every file needs a short-lived signed URL. Read access is `private.can_read_post()`, a SECURITY DEFINER mirror of `posts_read` -- if you change the audience rules on posts, change it there too.
   - **Filled pills paint cream on `--terracotta-text` / `--sage-text`, never on the pure brand hues.** Cream on `--terracotta` is only 4.01:1 and on `--sage` 4.05:1, both failing AA for the small bold text a pill uses. The text-safe variants look the same and clear 4.5:1.
   - Eyebrows on a **navy ground** must use `--terracotta-on-navy`; the canvas accents are only 2.85-3.47:1 there and fail AA. There is a rule listing those containers near the end of the stylesheet -- add to it when you introduce a new dark surface.
  - `formatDate`/`formatMoney` in `lib/compliance.ts` pin locale and time zone deliberately. `toLocaleDateString(undefined, ...)` differs between server and client (hydration mismatch) and renders a date-only column a day early in Central Time.
  - `@import "tailwindcss/preflight"` is load-bearing — the stylesheet depends on its reset. Do not remove it. No Tailwind utilities are used.
9. **Brand assets** live in `public/brand/`. Use the horizontal lockup in headers, stacked in the hero, the cream variant on dark fields, and the compact mark below 64px. Full-resolution masters are outside the repo in `~/Downloads/veritas-village-logo-assets/`.

## Production baseline before the 25 Aug local pass
Everything below describes the previously deployed production baseline. The dated section at the top lists the newer local changes that still need release.

**Family portal**: dashboard with children (click a child → classes/assignments/family-visible teacher notes with read-receipts), clickable News/Events/Documents (open a detail modal instead of a flat list), self-service add-a-child (button-triggered form) and display-name edit, Account & Security accessible from the header's account menu (password change, passkeys, TOTP 2FA, phone/emergency contact, self-service account deletion).

**Teacher's Lounge**: one class selection at the top drives the whole page — there are no per-section class dropdowns. Sections, in order: **Teaching team news** (read-only, narrowed to the `teachers` audience plus the teacher's own `class` posts -- co-op-wide news is deliberately excluded, they see that in the family portal), My classes (roster; clicking a student reveals their notes, hidden until then), **Class dates**, Handouts, Print queue.

**Class dates replaced homework.** One entry says what is being worked on, the date, where, instructions, and a `requires_prework` flag -- families see "Something to do before class" on the date rather than a separate homework row. Stored in `events` with `audience = 'class'` at **midday UTC** so the date cannot slide across midnight when read in Central Time; the form is date-only on purpose, since a co-op class has a day not a start time. Class dates are kept **out of the family Village calendar**, which is co-op-wide only. The `assignments` table has been **dropped** -- homework is a flag on a class date now, and the child detail panel reads class dates too. Do not confuse it with `teacher_assignments`, which is who teaches what and is very much alive.

**The print queue** lists every request the teacher has made across all classes, each labelled with its class, because someone printing for three classes needs one pile not three. It **empties automatically at 09:00 UTC each Sunday** (4am Central in summer, 3am in winter -- pg_cron schedules in UTC and does not follow DST) via the `clear-print-queue` job calling `public.clear_print_queue()`. That sets `cleared_at` rather than deleting, so the record and the uploaded file survive; the UI filters on `cleared_at is null`.

**Lead vs assistant.** `teacher_assignments.assignment_role` is now enforced through `private.leads_class()`. Assistants see everything and write student notes; leads additionally upload handouts, set homework and class dates, and send print requests. The UI hides what an assistant cannot do rather than letting them meet a denied write — if you add a control that writes, gate it on `isLead` *and* check the policy.

**Admin**: a 7-card dashboard (Accounts/Relationships/Classes/Documents/Publishing/Oversight/Configuration) is the default view. Sections: Invitations, Families (parents-first with email/phone, then children, role-assignment chips for teacher/admin), Classes (create/assign teachers/manage enrollment), Documents (upload a PDF, place signature fields for one or two signers, send to households, follow per-signer status; see **E-signing** below), Village news (posts with multiple photos or files attached), Activity (audit log viewer), Integrations (status tracker; Resend and the office printer queue are live, the rest are notes).

**Compliance**: required documents and dues, tracked per family per school year. `school_years` scopes everything (one row flagged `is_current`, enforced by a partial unique index); `requirements` is what families owe that year, either a `document` to sign or `dues` to pay; `family_requirements` is the per-family matrix. Families see an outstanding-items banner and a **Paperwork & dues** list; admins get a **Compliance** tab with a families x requirements matrix, plus status chips on each card in Families. Shared presentation logic is in `lib/compliance.ts` -- use `statusLabel`/`statusTone` rather than restating the vocabulary.

Dues amounts are captured when a requirement is opened, not derived on read, so enrolling a child mid-year cannot silently change a figure a family was already shown; admins press **Recalculate balances** on purpose. Dues are **tracked, not collected** -- the co-op banks with Crowded, whose API is a partner programme for software platforms rather than something an account holder can connect to, so the portal stores the Crowded payment link and an admin records receipt.

**Shared**: one `AppHeader` component (the real horizontal lockup top-left, portal title, workspace switcher, account menu top-right) across all three portals. It renders as a full-bleed band whose colour identifies the workspace: cream with a terracotta rule for Family, a sage tint for Teacher, reversed navy with the cream lockup for Admin.

**Auth in the previous production bundle**: email/password, unconfigured Google/Apple buttons, and passkeys. The current local pass removes the Google/Apple options from sign-in and removes passkey management from Account settings, while retaining TOTP 2FA and the authenticator-assurance-level challenge.

## Known gaps / good next steps (raised but not yet built)

### E-signing (built in; replaced OpenSign in Nov 2026)

Signing happens inside the portal for a signed-in person. There is no public or emailed signing link and no outside signing service.

- **Tables** (`20261106235100_esign_schema.sql`): `sign_templates` (an uploaded PDF), `sign_fields` (page-relative fractions from the top-left, kind signature/initials/date/text/checkbox, signer slot 1 or 2), `sign_requests` (one per household; keeps the SHA-256 of the file it was sent with), `sign_signers`, `sign_field_values`, `sign_events`. `requirements.sign_template_id` ties a required document to its PDF.
- **Writes only through functions** (SECURITY DEFINER, `search_path ''`): admin `sign_create_template`, `sign_save_fields`, `sign_archive_template`, `sign_send`, `sign_remind`, `sign_void`; signer `sign_eligibility`, `sign_record_view`, `sign_give_consent`, `sign_submit`, `sign_log_download`; service role only `sign_claim_seal`, `sign_mark_seal_failed`, `sign_complete`, `sign_log_timestamp`. Tables are read-only to clients, with RLS and the restrictive `aal2_required` policy. Tests: `supabase/tests/database/013_esign.test.sql`.
- **Who may sign** (`private.signing_blockers`): active profile, invitation accepted (email confirmed, no unaccepted invite), a name on the profile, a verified second factor or passkey in `auth.mfa_factors`, and a session at aal2. Enforced inside consent and submit, not just in the page.
- **Audit trail**: `sign_events` and `sign_field_values` refuse UPDATE/DELETE/TRUNCATE by trigger and by revoked privileges (even for `service_role`). IP and user agent come from PostgREST's request headers (`cf-connecting-ip`, then `x-real-ip`, then `x-forwarded-for`), not from the browser. Event actors have no foreign key on purpose: an append-only table cannot take a `set null`.
- **Locks**: once a template has a request, its fields and file are frozen; a request cannot be deleted, and a sealed request cannot be replaced or voided. To change fields, duplicate the document.
- **Sealing** (`supabase/functions/esign-seal`, logic in `_shared/esign-seal.ts` and `_shared/esign-pdf.ts`, `pdf-lib`): the last signer's browser calls it; an admin can retry from Admin, Documents. It re-hashes the stored original against the request's hash, flattens the entries onto the pages, appends a certificate page, stores `signed-content.pdf`, `sealed.pdf` and the timestamp files under `sign/requests/<id>/` in `family-village-private`, then calls `sign_complete`, which files a `documents` row, marks the `family_requirements` row complete and notifies everyone. Text is drawn with the standard PDF fonts, so characters outside WinAnsi become `?` in the flattened copy.
- **Timestamp** (`_shared/rfc3161.ts`): RFC 3161 token from DigiCert by default (`TIMESTAMP_AUTHORITY_URL` secret changes it; `disabled` turns it off). The first token covers the signed content (not the certificate page, which prints it); a second covers the finished file. Verification steps are in `docs/esign-timestamp-verification.md`. It is not a PAdES signature.
- **Pages**: Admin, Documents tab (`admin/documents-tab.tsx`, `field-editor.tsx`, `send-panel.tsx`, `sent-list.tsx`); family signing page `/family-village/paperwork/sign?request=<id>` (`paperwork/sign/`); Paperwork list shows the status. The PDF viewer is `pdfjs-dist` (legacy build, worker emitted as our own asset via `?url`, `worker-src 'self'`); nothing loads from a CDN.
- **Keeping records**: signing records outlive account and household deletion (`20261106235200_esign_account_erasure.sql`): the signer's email is cleared, the name stays, sealed files under `sign/` are not deleted. The privacy policy says so.
- **Retired OpenSign** (migration `20261107000100_drop_opensign.sql`, edge functions removed from the repo). Kept on purpose: `family_requirements.provider_document_id` and `certificate_url`, and `documents.provider_document_id`/`signature_provider`, because the Family handbook signed through OpenSign on 23 Aug 2026 still points at them. **Deployed edge functions are not removed by `supabase functions deploy`**: `opensign-send`, `opensign-sync` and `opensign-webhook` must be deleted by hand (`supabase functions delete <name> --project-ref jtwemgyhxylbhjzxgyvh`), and the `OPENSIGN_API_TOKEN` and `OPENSIGN_WEBHOOK_SECRET` secrets unset.
- Whether a parent's electronic signature is enough for a liability waiver involving a minor is a question for the co-op's attorney; the privacy policy and terms carry a flag.

- ~~**Google/Apple OAuth** buttons were visible but unconfigured.~~ **Closed locally 25 Aug:** the sign-in screen is email/password only. This is not live until the current site bundle is released.
- **Dues/payments**: `docs/dues-processor-options.html` compares Stripe, Cheddar Up and Zeffy against the real dues structure. Recommendation is Stripe with ACH as the default method. No payments code exists yet; Sam still owes an actual family count and a board decision on absorbing vs passing on fees.
- **A parent-only account does not exist yet.** Both current users are administrators, so the family-scoped RLS has been verified at the predicate level (`private.has_family_access` grants each user only their own family, checked both directions) but never exercised end to end by a non-admin. Worth confirming with a real parent account before the co-op relies on it.
- **Print automation is designed but not built.** Decision made: a small agent on an always-on machine at Sam's house polling `print_requests` for `status = 'pending'`, printing via `lp`/CUPS, and setting `status = 'printed'`. Waiting on hardware. Email-to-print was rejected because it cannot report back whether anything printed — and HP retired ePrint's email service in 2023, Google Cloud Print in 2020, so it is mostly gone anyway. The agent will need its own edge function and secret; do not hand a service-role key to a home machine.
- **Homeschool co-op features not yet built**, discussed as good candidates: attendance tracking, parent volunteer-hour tracking, field trip/event RSVP with headcount, per-class supply/curriculum lists, a lending library, carpool coordination, a "closed today" alert banner.
- **Classes now have a real timetable.** `class_blocks` (label + `starts_at`/`ends_at`, per school year) is the single source of a class's meeting time — `classes.block_id` points at one, and `classes.meeting_time`/`block_label` are **dropped**. `rooms` is a managed list with `classes.room_id`. Both are managed from collapsible sections in Admin → Classes. Display goes through `lib/schedule.ts` (`describeSchedule`, `SCHEDULE_SELECT`) — do not format a block time with `toLocaleTimeString`, a bare `time` has no date and the browser timezone will shift it. **Neither table is seeded**: every class reads "No time block" until Sam defines the co-op day. A same-block-same-room double booking shows as a warning chip on the class card, deliberately not a constraint — a co-op does legitimately share a big room.
- **Three table-level traps worth remembering** (all three bit this session): a new table with RLS and policies but **no `GRANT`** fails `42501` for everyone, because privileges are checked before RLS; a `SECURITY DEFINER` function with a null `proacl` is `EXECUTE` to `PUBLIC`, which PostgREST publishes at `/rest/v1/rpc/<name>` — the Supabase API is **not** behind the Cloudflare password gate; and **`GRANT ... TO authenticated` is not enough** — every admin-gated edge function bypasses RLS with a service-role client, and this project's default privileges for tables owned by `postgres` (every table created by a migration) never included `service_role`. It silently worked in the browser (as `authenticated`) and silently failed in every server-side call (as `service_role`) for every single table, discovered only when an admin check in an edge function returned a genuine Postgres `permission denied for table profiles` for a database-confirmed active admin. Fixed for good in `20260823041733_restore_service_role_grants.sql`, which both back-grants every existing table and corrects the default privilege for future ones — **a new table only needs `GRANT ... TO authenticated` from here on**, `service_role` now comes free. Run `get_advisors(type: "security")` after adding any of the three.
- **Migration filenames must carry their real `apply_migration` timestamp, exactly.** `supabase db push` (now run by CI on every push to `main` — see the Supabase deploy job below) matches a local file against `supabase_migrations.schema_migrations` by exact version-number equality, not by name. Every migration this project authored through 27 Aug used an approximate, hand-typed timestamp in its filename rather than the real one `apply_migration` recorded — 50 of the 64 files were out of sync with their live version, which `db push` would have read as 50 "new" migrations and tried to reapply, erroring on the first non-idempotent `create table`/`create policy` it hit. Reconciled once via a bulk `git mv` matching by migration *name* against `list_migrations`' live version numbers (27 Aug). **Going forward: never hand-pick a migration's filename timestamp.** Use the value `apply_migration` actually returns/records, or run `list_migrations` right after applying and rename to match before committing.
- ~~**Admin "Publishing" card** did not cover calendar events.~~ **Closed locally 25 Aug:** it is now **News & calendar**, with create/edit/delete support for co-op-wide events. This is not live until the current site bundle is released.
- **Integrations tab** is notes-only for every service except Resend (email) and the office printer queue, which are wired.

- ~~**MFA/passkey login gating** only on `/home`~~ — **closed.** `lib/use-portal-access.ts` performs the AAL check for every workspace, and all three portals share `MfaChallengeScreen`.
- **`public.integration_settings` (and `enrollment_periods`, `enrollment_requests`, a few `classes` columns, one function) have never appeared in a migration.** They were created by hand early on, so replaying the history into an empty database cannot reproduce them. CI works around it with throwaway stand-ins in `supabase/ci-bootstrap/` (see Tests below); production is untouched. Replacing the stand-ins with one real baseline migration is the proper fix and is worth doing before anyone rebuilds the database from scratch. Two later gaps *were* closed with real, no-op-in-production migrations: `record_untracked_table_grants` (table privileges that existed only in production) and `record_protect_last_admin` (the trigger that stops the final admin role being deleted). Still hand-made and not recorded: the older `default_child_surname` / `default_family_surname` functions and triggers (they look like superseded duplicates of `default_child_last_name`), and about 39 extra per-command admin policies alongside the `_admin_write` ones.

## Tests
CI runs five jobs; the three deploy jobs wait for the first three.
- `build-lint-test`: ESLint, `tsc`, and `tests/rendered-html.test.mjs`.
- `edge-function-tests`: `deno check` on every function, then `deno test` for `supabase/functions/_shared/*.test.ts` (shared helpers; the invitation resend/delete logic against an in-memory fake database) and `calendar-feed/feed.test.ts`. Runs locally with `cd supabase/functions && deno test --node-modules-dir=none --config invite-family-admin/deno.json _shared/ calendar-feed/`.
- `database-tests`: starts a fresh local Supabase (Docker), replays every migration, runs the pgTAP files in `supabase/tests/database/` with `supabase test db`. These pin the rules that have each broken in production (profile/child self-service triggers for user, service-role and direct-SQL access; an admin removing their own access; the last admin; column grants the admin screens need; class capacity and prerequisites; push subscriptions; the notification inbox; invitation acceptance). No Docker on the Mac, so run them through CI, or paste a file into a rolled-back transaction against the live project.
- `supabase/ci-bootstrap/*.sql` are copied into the throwaway database's migration list **by CI only** (their filenames carry the version they slot in at). Never apply them to production.
- The replayed database is *more permissive* than production for `anon`/new tables (local Supabase default privileges), so a test proving something is *refused* is meaningful, but do not read "the replay allows it" as "production allows it".
- Pin: CI uses Supabase CLI 2.122.1 and Deno 2.8.2. Move either deliberately.

## How to verify a change is really live
```
curl -s -o /dev/null -w "%{http_code}\n" https://family.veritasvillage.org/family-village/home
NODE_ENV=development npx wrangler secret list --name veritas-village   # confirm SITE_AUTH_SECRET/SITE_PASSWORD survived the deploy
```
