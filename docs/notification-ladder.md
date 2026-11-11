# Notification fallback ladder

Push goes first. If a person has not seen an important notification after a day, or cannot be pushed at
all, it goes to their email, and by text only if they agreed to texts.

Code: `supabase/migrations/20261113090000_notification_ladder.sql`, the `deliver-notifications` edge function,
`supabase/functions/_shared/notification-delivery.ts` and `sms.ts`. Tests: `supabase/tests/database/019_notification_ladder.test.sql`
and `supabase/functions/_shared/notification-delivery.test.ts`.

## The rules

| Situation | What happens |
| --- | --- |
| Person has a device and push is on | Push goes out within a minute (`deliver-push`). Email waits `fallback_hours` (24). |
| Person has no device, or turned push off | No wait. Email is queued at the next ladder run (at most 15 minutes). |
| Push was attempted and failed for every device | No wait, same as above. |
| Person turned email off | No email, ever. |
| Person is in "only urgent things" mode | Nothing but urgent alerts is pushed, emailed or texted. Routine items stay in the bell. |
| Person agreed to texts, notification kind is on the important list, master switch on | Text, `sms_extra_hours` (0) after the email is due. |
| Profile is not active, or is a reviewer (demo) account | Never contacted on any channel. |
| Notification is for a muted conversation | Not emailed or texted. |

"Seen" means the person read it in the bell (`read_at`) or tapped the push notification (`push_opened_at`).
Push links carry `?vvn=<notification id>`; when the page loads, the app calls `record_notification_open` and removes
the marker from the address. Either one stops the ladder.

Only kinds on the lists are touched. Defaults: email fallback for `broadcast_urgent`, `broadcast_important` and
`broadcast_notice`; text for `broadcast_urgent` and `broadcast_important`. Chat messages, news and the rest keep
working exactly as before (bell and push). Document and dues reminders already send their own email, so they are
not on the list.

## Settings (Admin, Integrations, "Email and text fallback")

| Setting | Default | Meaning |
| --- | --- | --- |
| Wait before email | 24 hours | How long push gets. 1 to 168. |
| Extra wait before a text | 0 hours | Added after the email is due. |
| Email fallback kinds | broadcast urgent / important / notice | Which kinds fall back to email. |
| Text kinds ("important") | broadcast urgent / important | Which kinds may be texted. |
| Email fallback on | on | Master switch. |
| Text messages on | off | Master switch. Leave off until a texting account exists. |

Changes are written to the audit log and apply at the next ladder run.

## How it runs

- `notification_preferences`: one row per person who changed something (no row means push on, email on, texts off).
- `notification_deliveries`: one row per notification, channel and attempt, with status, reason, provider message id and error.
  The key `(notification_id, channel, attempt)` is unique, so running the ladder twice cannot queue twice.
- `notification-ladder` (pg_cron, every 15 minutes) runs `private.run_notification_ladder()`: closes sends that never
  reported back, queues what is due, and retries failures (three tries, 15 minutes apart, only while still unseen and
  only if the failure could pass: a bounced address is not retried).
- `deliver-notifications` (pg_cron, every minute, only when something is queued) calls `claim_deliveries()`. That
  function checks every rule again at the moment of sending: seen since, channel switched off, profile no longer active,
  agreement withdrawn, number changed, or older than a day. Rows that fail are closed as `skipped` with the reason.
  Claimed rows are marked `sending`, so two overlapping runs cannot take the same row.
- Email goes through the same Resend setup as every other email (`getFromAddress`, `RESEND_API_KEY` in Vault) and is also
  written to `email_outbox` for the audit trail. The delivery id is sent as Resend's idempotency key.
  If Resend is not configured, email rows stay queued and expire after a day instead of being sent late.
- If the sender dies mid-run, the row is closed as `interrupted` after 15 minutes and may be retried. That is the only
  path where a person could get a message twice.

## Dry runs and tests

Nothing in tests or development contacts anyone: the database tests have no network, the Deno tests replace `fetch`
and the texting provider with fakes. For a dry run against a real project, set `DELIVERY_ALLOWLIST` on
`deliver-notifications` (comma-separated emails and phone numbers). Anything not on the list is skipped with the
reason `not_on_allowlist`. Leave it unset in production.

## Email setup for reliable delivery

`deliver-emails` and the ladder both send through Resend. The From address is the one in Admin, Integrations, Resend
("From address"), and the API key is `RESEND_API_KEY` in Vault. Check those two first; I could not read the live values.

For mail to land in inboxes rather than spam, the sending domain needs these DNS records. Resend shows the exact values
under Domains once the domain is added.

1. **SPF and DKIM through Resend.** Add the domain (or a subdomain such as `mail.veritasvillage.org`) in Resend and
   publish the records it lists. Resend uses its own return-path subdomain, so this does not clash with Google
   Workspace's SPF record on the main domain. Do not merge two SPF records into one line by hand; keep Workspace's
   `include:_spf.google.com` on the root and let Resend's records live on the subdomain it asks for.
2. **DMARC.** Publish `_dmarc.veritasvillage.org` as `v=DMARC1; p=none; rua=mailto:<a Workspace mailbox>`. Watch the
   reports for a few weeks, then move to `p=quarantine`.
3. **A From address on that domain**, for example `Veritas Village <notifications@veritasvillage.org>`. A From on a
   domain Resend has not verified will be rejected or spam-foldered. Sam's Workspace mailbox can be the DMARC report
   address and the place replies go.
4. Open a test email in Gmail, "Show original", and confirm SPF, DKIM and DMARC all say PASS.

Not done here: a Reply-To header and a one-click unsubscribe header. Preferences live in Account settings, which the email
footer points to. Add both if inbox providers start filtering.

## Text messages: what exists and what is left

Built: consent storage and wording, preferences, queueing, claiming, logging, and a stub provider that sends nothing
(`sms.ts`). While the stub is active, queued texts are recorded as `skipped` with reason `provider_not_set_up`, so no
backlog builds up to be sent later.

### Consent

A number only counts when `set_my_sms_consent` recorded an agreement: the number (normalised to +1…), the time, how
the person agreed (`account_settings_checkbox`), and the wording version. The exact words are kept in
`sms_consent_log`, which is append-only. The Account Settings checkbox shows the wording from
`public.sms_consent_wording()`, so what the person reads is what is on record. A database constraint
(`sms_needs_consent`) makes it impossible to switch texts on without a number and a recorded agreement, and
`claim_deliveries` checks again at send time that the number has not changed since it was queued.

### STOP and HELP

- Every text ends with "Reply STOP to opt out, HELP for help." (`SMS_FOOTER`); truncation never removes it.
- STOP: carriers and providers block further messages to that number on their own. Our side must follow. When the
  provider calls a webhook for an inbound STOP, the webhook calls `public.record_sms_opt_out(phone)` (service role). It
  switches texts off for whoever owns the number and writes an `opt_out` row. The function exists and is tested; the
  webhook that calls it is part of the later two-way phase.
- HELP: the provider can answer HELP with a canned reply (Twilio does this by default). We do not build our own.
- Not built: replies, conversations, or any inbound handling other than the STOP report.

### Account steps for Sam (weeks of lead time, so start early)

1. Choose a provider (Twilio, Telnyx, or similar) and create an account.
2. US carriers require registration before any application-to-person text:
   - 10DLC: register the business ("brand") and the use case ("campaign": account notifications / school closures).
     Approval usually takes one to four weeks.
   - Or a toll-free number with toll-free verification, which tends to be faster for low volume.
   Registration asks for the legal name and EIN, a privacy policy URL, and the consent flow. The consent flow is the
   Account Settings checkbox; the wording is in `sms_consent_wording()`.
3. Put the provider key in Supabase Vault as `SMS_PROVIDER_KEY` (never in chat or git).
4. A developer adds the provider adapter: one object that satisfies `SmsProvider` in `_shared/sms.ts`, registered in
   `PROVIDERS` (about 40 lines), plus the inbound STOP webhook. Set `notification_settings.sms_provider` to its name.
5. Turn on "Text messages are on" in Admin, Integrations, and send the first test to Sam's own number with
   `DELIVERY_ALLOWLIST` set.
