# Veritas Village apps (iOS and Android)

Native apps around the live portal at `family.veritasvillage.org`. The portal
is **not bundled**: it is server-rendered and signed-in, so every web deploy
reaches the apps immediately with no store review.

- **iPhone** is a native frame written in Swift (`ios/App/App/Frame/`): native
  navigation, back-swipe, sheets and tab bar, with each screen's content loaded
  from the site. It does not use Capacitor. Read
  [`docs/native-ios-frame.md`](../docs/native-ios-frame.md) for how it works and why.
- **Android** is a [Capacitor](https://capacitorjs.com) shell: one web view around
  the portal. `www/` holds only a launch page that checks the connection and
  then opens the portal.

What makes it an app and not a bookmark is the native layer: push
notifications, biometric unlock, and native sharing and camera. Apple rejects
apps that are only a website in a frame (guideline 4.2), so these matter.

## Status
| | |
|---|---|
| iOS and Android projects, icons, splash, launch page | done |
| Builds and runs in the iOS simulator | done |
| Android debug build | checked by CI (`.github/workflows/mobile.yml`) |
| Native push notifications | **waiting on store accounts** (needs an Apple push key and a Firebase project) |
| Face ID / fingerprint unlock | not started |
| Opening invitation links in the app (universal links) | **waiting on the Apple Developer account** (needs the Team ID) |

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
npx cap sync android    # after changing www/ or capacitor.config.ts (Android only)
npm run assets          # after changing anything in assets/ (icon, splash)
npx cap open android    # Android Studio
open ios/App/App.xcodeproj   # Xcode, for the iPhone app
```
**Do not run a bare `npx cap sync`**: it would try to regenerate the iOS project as
a Capacitor one. The iOS project is plain Xcode with no packages. Capacitor needs
Node 22 or later (Android only now).

Testing the iPhone frame without signing in: `ios/test-pages/README.md`.
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
