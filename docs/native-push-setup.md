# Push notifications in the iPhone and Android apps: setup

The code is built (PR #73). Nothing is sent until the four steps below are done. They are in Apple's,
Firebase's and Supabase's dashboards, so only an account owner can do them. Do them in this order.

The app's existing web push (installed web app) is separate and keeps working.

## 1. Apple Developer: turn on Push Notifications for the app
1. developer.apple.com, Certificates, Identifiers & Profiles, Identifiers, `org.veritasvillage.family`.
2. Tick **Push Notifications**, save. (Apple Pay on the same page is the other capability the app needs; see
   `docs/native-apple-pay-setup.md`.)
3. In Xcode, open `mobile/ios/App/App.xcodeproj`, target App, Signing & Capabilities: Push Notifications and Apple
   Pay should show with no red errors. Automatic signing refreshes the profile.

## 2. Apple Developer: make an APNs key
1. Keys, **+**, name it `Veritas Village push`, tick **Apple Push Notifications service (APNs)**, continue, register.
2. Download the `.p8` file **once** (Apple shows it only once). Note the Key ID on that page and the Team ID
   (`VQUCJB5C7M`).
3. Keep the file out of the repo and out of chat. `.gitignore` already ignores `*.p8`.

## 3. Firebase: give Firebase the APNs key
1. Firebase console, the project that owns `GoogleService-Info.plist`, Project settings, **Cloud Messaging**.
2. Under Apple app configuration, **APNs Authentication Key**, Upload: the `.p8`, the Key ID, the Team ID.
3. Project settings, **Service accounts**, **Generate new private key**. This downloads a JSON file. That file is
   the server's key to send; treat it like a password.

## 4. Supabase: store the service-account key and deploy
1. Supabase dashboard, Vault (or SQL editor): create a secret named exactly `FCM_SERVICE_ACCOUNT` whose value is
   the whole JSON file as one string.
2. The migration `20261111090000_native_push_tokens.sql` (in #73) creates `register_device_token` and the
   token table. It applies when #73 merges (the `supabase-migrations` job).
3. `deliver-push` is redeployed by the `supabase-functions` job on merge.

## Try it
1. Install a build with the Push capability on a phone (Xcode, or TestFlight after the next upload).
2. Account & security, turn notifications on, allow the system prompt.
3. From another account, send a message or post news. The phone should get a notification; tapping it opens
   that page.
4. Sign out on the phone: it stops receiving them (the token is removed first).

## If nothing arrives
- The permission prompt appears but no token: the app was signed without the Push capability (step 1), or the
  phone is a Simulator (it has no APNs token).
- A token is saved but nothing is sent: `FCM_SERVICE_ACCOUNT` is missing or malformed (step 4), or the APNs key
  was not uploaded to Firebase (step 3). `deliver-push` logs the FCM error.
- Debug builds use Apple's sandbox push servers and release builds use production. Xcode switches
  `aps-environment` automatically; Firebase accepts one key for both.
