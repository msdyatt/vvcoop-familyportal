# Office inbox: setup

The office inbox shows the co-op's office email to administrators inside the portal (issue #112).
It reads one Google Workspace mailbox through the Gmail API and sends replies from that same
mailbox, in the same thread. This page lists what the owner sets up. Do staging first, with a
test mailbox, and only then production.

Nothing here needs a password or key pasted into chat, the repo or a GitHub issue.

## What it does and does not do

- Reads only the mailbox named in `OFFICE_INBOX_ADDRESS`. If someone signs in with a different
  Google account during the connect step, the portal refuses it and revokes the grant.
- Never deletes or trashes mail in Gmail and never marks it read there. Each message it imports
  gets the Gmail label **Portal imported**.
- Checks for new mail every minute (pg_cron calls the `office-inbox-sync` Edge Function). The first
  connect imports the last 30 days of inbox mail.
- Keeps the Google refresh token in Supabase Vault (`OFFICE_INBOX_REFRESH_TOKEN`). It never reaches
  the browser.
- Spam, trash, drafts and chats are skipped. Mail the office sends from Gmail directly shows up in a
  thread that already exists in the portal, but does not start one.

## 1. Choose the office mailbox

In the Google Admin console, pick (or create) the Workspace user that receives office mail, for
example `office@veritasvillage.org`. It must be a real user with its own Gmail, not a Google Group
(the Gmail API cannot read a group). If the co-op address is a group today, add the new user as a
member, or point the address at the user.

For staging, create a separate test user (for example `office-test@veritasvillage.org`) so test
replies never go to real families.

## 2. Create a Google Cloud project

1. Go to <https://console.cloud.google.com> signed in as a Workspace administrator.
2. Create a project under the **veritasvillage.org** organisation (not "No organisation"). Name it
   something like "Veritas Village portal".
3. In **APIs & Services → Library**, enable the **Gmail API**.

## 3. Set up the consent screen

In **APIs & Services → OAuth consent screen** (Google may call it **Google Auth Platform →
Branding / Audience**):

- User type: **Internal**. Only accounts in the co-op's Workspace can then use it, and Google does
  not need to review the app.
- App name: "Veritas Village portal". Support email: a co-op address.
- Scopes (**Data access**): add `https://www.googleapis.com/auth/gmail.modify`. That allows reading,
  labelling and sending. It does not allow permanent deletion.

## 4. Create the OAuth client

In **APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**. Name: "Office inbox".
- Authorised redirect URIs, one per environment:
  - Staging: `https://axfikwoazkvtnwcgpyhg.supabase.co/functions/v1/office-inbox-oauth`
  - Production: `https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/office-inbox-oauth`
- No JavaScript origins are needed.

Google then shows a client ID and a client secret. Copy them straight into Supabase in the next
step. You can use one client for both environments (with both redirect URIs), or make two.

## 5. Set the Edge Function secrets (staging first)

In the Supabase dashboard for the **staging** project (`vvcoop-staging`), open **Edge Functions →
Secrets** and add:

| Name | Value |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | the client ID from step 4 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | the client secret from step 4 |
| `OFFICE_INBOX_ADDRESS` | the test mailbox, for example `office-test@veritasvillage.org` |
| `PORTAL_SITE_URL` | the staging site address, for example `https://staging.veritasvillage.org` (no trailing slash) |

Later, repeat this on the **production** project with the real office mailbox and
`https://family.veritasvillage.org`.

The migration also creates a Vault secret, `OFFICE_INBOX_CRON_SECRET`, with a random value. It is
what the every-minute job presents to the sync function. Nobody needs to know or set it.

Staging also needs the three functions deployed (`office-inbox-oauth`, `office-inbox-sync`,
`office-inbox-send`) and the migration applied. CI does this for production when the PR is merged;
for staging it is whatever process deploys there.

## 6. Connect from the portal

Sign in to the portal as an administrator (with your second factor), then **Admin → Integrations →
Office inbox → Connect**. Google asks you to sign in: use the office mailbox itself (the test one on
staging), not your own account, and allow access. You come back to Integrations, which shows the
connected address and the last sync time.

**Disconnect** on the same card stops the sync, removes the token from Vault and revokes it at
Google. Conversations already imported stay in the portal.

If the card says **Needs attention**, Google stopped accepting the stored authorisation (the
password changed, the grant was revoked, or the user was suspended). Connect again.

## 7. Check the domain's email settings

Replies are sent by Gmail from the office address, so the domain's DNS must allow Google to send
for it. In Cloudflare DNS for `veritasvillage.org`:

- **SPF**: the TXT record that starts `v=spf1` must include `include:_spf.google.com`. Resend is
  already used for portal notifications; keep its entry too. There must be only one `v=spf1` record.
- **DKIM**: in the Google Admin console, **Apps → Google Workspace → Gmail → Authenticate email**,
  generate a key and add the TXT record it gives (`google._domainkey`). Then press **Start
  authentication**.
- **DMARC**: a TXT record at `_dmarc` such as `v=DMARC1; p=none; rua=mailto:<a co-op address>`. Move
  to `p=quarantine` once reports show Google and Resend both pass.

A quick check: send yourself a reply from the portal, open it in Gmail, choose **Show original**,
and confirm SPF, DKIM and DMARC all say PASS.

## 8. Test on staging

With the test mailbox connected on staging:

1. From a personal address, email the test mailbox. Within a minute or two it appears in the
   portal's office inbox as **New**.
2. Open it, add an internal note, assign it, and reply. Check the reply arrives in the same thread in
   your mail app, from the test office address, and that the note did not.
3. Reply again from your mail app. The conversation goes back to **Open** in the portal.
4. Send an email with a PDF or photo attached and open the attachment from the portal.
5. In Gmail (signed in as the test mailbox), check the messages have the **Portal imported** label
   and are otherwise untouched.

Only then set up production (steps 5 and 6 on the production project, with the real mailbox).

## Limits and safeguards

- Administrators only, with the second factor when they have one, never a reviewer account.
- 20 replies an hour per administrator, 60 an hour for the whole office, and one per conversation
  every 10 seconds. A double click sends once.
- Every send, assignment, status change, category change, note, attachment opening, connect and
  disconnect is recorded in the conversation's history and in Admin → Activity.
- Email HTML is cleaned before it is stored and shown in a sandbox with remote images blocked until
  an administrator asks to load them.
- Attachments up to 15 MB are copied into a private storage bucket and opened through a two-minute,
  logged link. Larger files stay in Gmail and the portal says so.

## Switching to push later

Polling once a minute costs one Gmail history call a minute, well within Gmail's free quota. To get
mail within seconds instead:

1. In the Google Cloud project, enable **Cloud Pub/Sub**, create a topic (for example
   `office-inbox`), and grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher**
   role on it.
2. Add a push subscription that posts to a new Edge Function (say `office-inbox-push`). Protect it
   with a token in the push URL or Pub/Sub's OIDC token, checked by the function.
3. After connecting, call `users.watch` with the topic name and `labelIds: ["INBOX"]`. A watch lasts
   7 days, so renew it daily from pg_cron.
4. The push message only carries the new history id. The function then runs the same `runSync` as
   today (`supabase/functions/_shared/office-inbox.ts`), so importing does not change.
5. Keep the poll as a fallback, every 10 or 15 minutes, in case a push is missed.

## Where the code is

- Migration: `supabase/migrations/20261119090000_office_inbox.sql` (tables, access rules, the
  functions the screens and Edge Functions call, the poll job).
- Edge Functions: `office-inbox-oauth`, `office-inbox-sync`, `office-inbox-send`, with the logic in
  `supabase/functions/_shared/gmail.ts`, `office-inbox.ts`, `office-inbox-mail.ts` and
  `office-inbox-env.ts`.
- Tests: `supabase/tests/database/031_office_inbox.test.sql` and
  `supabase/functions/_shared/office-inbox.test.ts` (fake network; they never call Google).

## Open questions (from #112)

- Retention: imported mail is kept until removed. Nothing deletes it yet; decide how long to keep it.
- Spam: Gmail's spam filter runs first and spam is never imported. There is no "mark as spam" in the
  portal yet; mark it **Done**.
- Portal messages and texts in the same thread list are not part of this yet.
