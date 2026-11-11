# Apple Pay and Google Pay inside the apps: setup

Why this exists: Apple Pay on the web only works in Safari or Apple's browser sheet, not inside an
app's embedded web view. For Apple Pay (and a smooth Google Pay) *inside* the Veritas Village apps,
the apps use Stripe's native payment sheet. The code is in place; this is the one-time setup in
Apple's, Stripe's and Google's dashboards. Do it in Stripe **test mode** first, then repeat the
Stripe steps in live mode before going live.

## Apple (iPhone app)

1. **Create the merchant ID.** developer.apple.com → Certificates, Identifiers & Profiles →
   Identifiers → **+** → *Merchant IDs* → description `Veritas Village`, identifier
   `merchant.org.veritasvillage.family`. (If you prefer another name, tell me; it appears in
   `lib/dues-api.ts` and `mobile/ios/App/App/App.entitlements`, and they must match.)
2. **Get a certificate request from Stripe.** Stripe Dashboard → Settings → Payments → Apple Pay →
   **Add new application** (under *iOS certificates*) → download the **CSR** file.
3. **Make the Apple Pay certificate.** Back in Apple's page for your merchant ID → *Apple Pay
   Payment Processing Certificate* → **Create certificate** → upload Stripe's CSR → download the
   `.cer`. Upload that `.cer` back in Stripe on the same screen.
4. **Turn Apple Pay on for the app.** Identifiers → `org.veritasvillage.family` → enable *Apple Pay
   Payment Processing* and pick the merchant ID. In Xcode (Signing & Capabilities) the *Apple Pay*
   capability should list `merchant.org.veritasvillage.family`.
5. **Build a new version of the app** (the web changes are live without a release, but the
   native sheet needs this new build) and install it on an iPhone via TestFlight or Xcode.
6. **Try it.** In test mode Stripe does not charge, so a real card in Apple Wallet is safe to use
   to see the Apple Pay sheet. Bank transfer and card also appear in the same sheet.

## Google (Android app)

1. Test mode works without Google's approval (the app marks Google Pay as "testing" while the key
   is a `pk_test_` key).
2. Before live mode: register at the Google Pay & Wallet Console with the co-op's business profile
   and request production access for the app (Google asks for app screenshots of the payment
   screen). Stripe's own Google Pay guide lists the current steps.

## What families see

- In the **iPhone and Android apps**: tapping Pay opens a payment sheet that slides up inside the
  app, with Apple Pay / Google Pay at the top, then bank transfer and card.
- On the **website**: the payment form is embedded in the page.
- An app version without this update keeps working: it opens Stripe's page in the browser sheet.
