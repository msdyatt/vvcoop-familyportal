# Stripe setup checklist for Veritas Village

For Sam. Nothing here needs code. Do it in this order; each step says what you
should see when it worked. **Never paste a key into chat, email, a text file in the
repo, or a GitHub comment.** Keys go into Supabase Vault (step 6) and nowhere else.

The portal is built and tested against Stripe's **test mode** (a "sandbox" in newer
Stripe accounts). Nothing here moves real money until the last section, and that part
needs a second administrator.

## 1. Create the Stripe account

1. Go to <https://dashboard.stripe.com/register>. Use a co-op address you control long
   term, not a personal one (it becomes the account owner).
2. Choose **business type: Non-profit** (or "Non-profit organization / 501(c)(3)").
3. Have ready: the co-op's legal name exactly as on the IRS letter, its EIN, address,
   phone, a short description ("a homeschool cooperative; we collect annual dues from
   member families"), the website (`veritasvillage.org`), and the personal details of
   the person who is the account representative.
4. Statement descriptor (what appears on a family's bank statement): `VERITAS VILLAGE`.
5. **Add a second owner or admin** in Settings → Team, so the account does not depend on
   one person.

You should see: a dashboard with a "Test mode" (or "Sandbox") switch.

## 2. Add the bank account for payouts

Settings → Business → Bank accounts and currencies → add the co-op's Crowded account:
routing number and account number. These go into Stripe's own form only. Stripe verifies
the account with small deposits or instantly.

## 3. Ask for the nonprofit rate (optional, do not count on it)

Apply at <https://stripe.com/nonprofits> (or ask Stripe support from the dashboard) with the
IRS determination letter. The finance memo notes the discount is aimed at organizations
whose volume is mostly donations, so dues may not qualify. Ask the CPA, then budget at the
standard rate (2.9% + 30¢ cards, 0.8% capped at $5 for bank transfer) until Stripe says yes.

## 4. Turn on the payment methods

Settings → Payments → Payment methods. Make sure these are **on**:

- **Cards**
- **ACH Direct Debit** ("US bank account")
- **Apple Pay** and **Google Pay** (they appear automatically under cards on Stripe's
  hosted payment page; no domain setup is needed for that page)

Turn off any you do not want families to see. The portal asks for bank transfer first, then
card.

**Register the site for Apple Pay and Google Pay on the embedded form.** Settings → Payments →
Payment method domains → **Add a domain** → `family.veritasvillage.org` (do it once in test
mode and again in live mode). Without it the embedded form still takes cards and bank transfers,
but Apple Pay and Google Pay will not appear on the website.

In the iPhone and Android apps the payment is Stripe's native payment sheet inside the app (Apple Pay,
Google Pay, bank or card), as long as the publishable key is in Vault (step 6). Admin → Dues → Settings →
**Check Stripe connection** says whether it is.

Also: Settings → Branding. Upload the Veritas Village logo and set the brand colour, so the
payment page looks like the co-op's.
Settings → Customer emails: switch on **Successful payments** and **Refunds** if you want
Stripe to email a receipt as well as the portal's own PDF receipt.

## 5. Get the test keys

1. Make sure the dashboard is in **Test mode** (sandbox).
2. Developers → API keys. Copy the **Publishable key** (`pk_test_...`; it is meant to be public) and reveal the **Secret key** (`sk_test_...`).

Keep that tab open for step 6. Do not copy it anywhere but Vault.

## 6. Put the keys in Supabase Vault

1. Open the project at <https://supabase.com/dashboard/project/jtwemgyhxylbhjzxgyvh>, then
   Integrations → Vault → Secrets.
2. **Add new secret** for each:

   | Name (exactly) | Value |
   | --- | --- |
   | `STRIPE_SECRET_KEY_TEST` | the `sk_test_...` key |
   | `STRIPE_PUBLISHABLE_KEY_TEST` | the `pk_test_...` key. **Needed for in-app payment.** With it the payment form appears inside the Dues page and the iPhone and Android apps show Apple Pay / Google Pay in the app's own payment sheet; without it families are sent to Stripe's own page in a browser |
   | `STRIPE_WEBHOOK_SECRET_TEST` | the `whsec_...` signing secret from step 7 |

3. Later, for live mode, add `STRIPE_SECRET_KEY_LIVE`, `STRIPE_PUBLISHABLE_KEY_LIVE` and
   `STRIPE_WEBHOOK_SECRET_LIVE` the same way (see the last section).

The portal checks that the key matches the mode. A live key in the test slot is refused
and nothing is sent to Stripe.

## 7. Add the webhook

Stripe tells the portal when a payment settles or fails. Without this, payments are never
marked paid.

1. Developers → Webhooks → **Add endpoint** (in test mode).
2. Endpoint URL: `https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/stripe-webhook`
3. API version: `2025-09-30.clover` if the dashboard offers it (the portal pins that
   version for its own requests).
4. Select these events (if one is not offered in your account, skip it):
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `payment_intent.processing`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
   - `refund.created`, `refund.updated`, `refund.failed`
   - `charge.dispute.created`, `charge.dispute.closed`
   - `payment_method.detached`
5. After saving, click **Reveal** next to *Signing secret* (`whsec_...`) and add it to Vault as
   `STRIPE_WEBHOOK_SECRET_TEST` (step 6).

You should see: in the endpoint's page, events delivered with status 200 once you try a
test payment.

## 8. Switch the portal to test mode and try it

1. Sign in as an administrator → Admin → **Dues** → Settings.
2. Click **Check Stripe connection**. It should show your account name and "Test mode".
   If it shows a message instead, it names the exact thing that is missing.
3. Set the mode to **Test**.
4. Open dues for the school year, then sign in as a parent (or use a second browser) and pay.

Stripe's test details:

- Card: `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP. Declined card:
  `4000 0000 0000 0002`. Insufficient funds: `4000 0000 0000 9995`.
- Bank transfer: on the payment page choose the **test institution** Stripe offers
  ("Test (non-OAuth)" or similar) and use the success account. Stripe's testing page,
  <https://docs.stripe.com/testing#ach-direct-debit>, lists the test accounts for failures
  and for the micro-deposit path.
- Apple Pay: in test mode Stripe does not charge, so you can use a real card in Apple
  Wallet on Safari or an iPhone. Google Pay is the same in Chrome.

## 9. Fill in the receipt details

Admin → Dues → Settings → Receipts: the legal name, EIN, address and any wording the CPA
wants on a receipt. Until the EIN is filled in, receipts do not show one.

## Going live (only when you decide to)

Do this only after a full rehearsal in test mode and after the attorney questions in
`docs/stripe-dues-implementation.md` are answered.

1. Stripe must have finished verifying the account (charges and payouts enabled).
2. Switch the dashboard to live mode. Add the **live** secret key as
   `STRIPE_SECRET_KEY_LIVE`. Add a second webhook endpoint, same URL, in live mode, with
   the same events, and put its signing secret in Vault as `STRIPE_WEBHOOK_SECRET_LIVE`.
3. Admin → Dues → Settings → **Clear test data** (removes only test-mode rows).
4. One administrator requests "Go live"; a **different** administrator approves it in
   Admin → Dues → Approvals; then the first switches the mode. Approvals expire after
   30 minutes and can be used once. If you are the only administrator, add a second one
   first; the portal will not let one person do both.
5. Do a small real payment first and refund it (refunds also need a second person's
   approval in live mode).
6. Clear `payment_url` on the dues requirement so no one pays through the old Crowded link.

To stop everything quickly: Admin → Dues → Settings → mode **Off**. Payments already in
flight finish and are still recorded.
