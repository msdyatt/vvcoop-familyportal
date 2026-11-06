# Veritas Village apps (iOS and Android)

A native shell, built with [Capacitor](https://capacitorjs.com), around the live
portal at `family.veritasvillage.org`. The portal is **not bundled**: it is
server-rendered and signed-in, so every web deploy reaches the apps immediately
with no store review. `www/` holds only a launch page that checks the
connection and then opens the portal.

What makes it an app and not a bookmark is the native layer: push
notifications, biometric unlock, and native sharing and camera. Apple rejects
apps that are only a website in a frame (guideline 4.2), so these matter.

## Status
| | |
|---|---|
| iOS and Android projects, icons, splash, launch page | done |
| Builds and runs in the iOS simulator | done |
| Android debug build | checked by CI (`.github/workflows/mobile.yml`) |
| Native push notifications | **built; needs two uploads to go live** (see below) |
| Face ID / fingerprint unlock | not started |
| Opening invitation links in the app (universal links) | not started; needs the Apple Team ID |

Web push already works in the installed web app (PWA); the native shell is what
brings push to the stores' apps and to iPhones without a Home Screen install.

## Identity
Bundle id / application id is `org.veritasvillage.family`. **It is permanent
once published**; changing it later means publishing a different app. Settle it
before the first submission.

## Working on it
```
cd mobile
npm ci
npx cap sync            # after changing www/ or capacitor.config.ts (also run it after a fresh clone: it creates ios/App/CapApp-SPM/symlinks)
npm run assets          # after changing anything in assets/ (icon, splash)
npx cap open ios        # Xcode
npx cap open android    # Android Studio
```
iOS uses Swift Package Manager (no CocoaPods). Capacitor needs Node 22 or later.
Icons and splash come from `assets/` (the brand mark on navy); `npm run assets`
regenerates every size. It also drops unused web icons in `mobile/icons`
(and sometimes `www/manifest.json`); delete them, they are not part of the app.

## What `capacitor.config.ts` decides
- Pages on `family.veritasvillage.org` and the Supabase host load inside the
  app; every other link opens in the system browser.
- `contentInset: never` on iOS: the page itself clears the notch and home
  indicator with `env(safe-area-inset-*)` in `app/globals.css`, so the same CSS
  works in the installed web app and in both native apps.

## Before the first store submission
Store accounts (D-U-N-S, Apple Developer organization with the nonprofit fee
waiver, Google Play organization), a privacy policy that covers children's data
and notifications, a demo account for the reviewers (the app is invite-only),
the native push work above, and real screenshots.

## Finishing native push
The code is in place: the app registers its Firebase token, the server stores it
beside browser subscriptions, `deliver-push` sends through Firebase Cloud Messaging
(one path for iPhone and Android), and tapping a notification opens its page. Two
things only you can do, both in consoles, neither in git or chat:
1. **Firebase console, Project settings, Cloud Messaging, Apple app configuration:**
   upload the APNs authentication key (the `.p8` from the Apple developer account) with
   its Key ID and your Team ID. This is how Firebase reaches iPhones.
2. **Firebase console, Project settings, Service accounts, Generate new private key,**
   then in the Supabase dashboard open Vault and add a secret named
   `FCM_SERVICE_ACCOUNT` containing that JSON. This is how our server sends.

Then in Xcode (`npx cap open ios`): Signing and Capabilities, pick your team (this adds
the Push Notifications capability to the App ID), and run on a real iPhone. The iOS
simulator cannot receive push. Turn notifications on in Account Settings, then use
"Send a test".

`GoogleService-Info.plist` and `google-services.json` are committed on purpose: they
hold client identifiers, not secrets. The `.p8` and the service-account JSON are
git-ignored.
