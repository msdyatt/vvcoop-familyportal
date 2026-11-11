# Native frame for the iPhone app

The iPhone app used to be one Capacitor web view with nothing native around
it. This note records how it becomes a native frame (tab bar, navigation bar,
push and back-swipe, sheets, pull to refresh, share sheet, Face ID) that still
loads every screen's content from the live site.

Status of each piece is at the end, under "What is verified".

## Decision

**A small custom frame in Swift, with no Capacitor in the iOS target.**
Android keeps its Capacitor shell and the PWA is untouched.

The site stays the only source of screen content. Reports, admin, signing,
records and forms are web pages, so a web deploy still reaches phones with no
store review. The frame owns the chrome (tab bar, navigation bar, back
gesture, sheets) and a few high-touch moments.

### Why not Hotwire Native

Hotwire Native is the obvious candidate and it was checked against its source
(`hotwire-native-ios`, main, August 2026), not from memory.

- Its page loading is built on the Turbo JavaScript library. A first load
  (`ColdBootVisit`) finishes only when the page's Turbo adapter reports
  `pageLoaded`, and the adapter script throws "Failed to register the
  TurboNative adapter" when neither `window.Turbo` nor `window.Turbolinks`
  exists. This site is React with ordinary page loads and has neither. Every
  visit would stall until we faked a Turbo object in each page.
- It cancels any response that is not 2xx, which is stricter than we want for
  pages that render their own error states.
- Its bridge components expect Stimulus on the page. We would write the web
  half ourselves anyway, since the site is React.
- Its tab bar helper is a `UITabBarController`. A person can pick five
  shortcuts and the Menu button is always added, which is six tabs. On iPhone a
  tab bar controller folds the fifth and sixth into a "More" list.
- What is useful in it is small: the path-configuration idea (a JSON file of
  URL patterns that say push, modal or replace), the modal and push
  vocabulary, and the shape of bridge messages. We take those ideas and skip
  roughly 5,800 lines that assume Turbo.

### Why not keep Capacitor in the iOS target

- Capacitor's bridge belongs to one `CAPBridgeViewController` and one web
  view. A native frame has one web view per page. A page pushed onto the stack
  would have no bridge, so `window.Capacitor` plugins would not work there.
- Everything Capacitor gives the iPhone app today is a few lines natively:
  external links (`SFSafariViewController`), status bar (view controller),
  splash (the launch storyboard, which stays), app events (scene delegate),
  push (Firebase iOS SDK, below).

### What is replaced on iOS

| Today (Capacitor) | Native frame |
|---|---|
| `CAPBridgeViewController`, one web view | `FrameController`, a `UINavigationController` per tab, a `WebPageController` per page |
| `window.Capacitor` injected into the page | `window.VVNative` injected at document start, plus `data-frame` on `<html>` |
| App, Browser, StatusBar, SplashScreen plugins | UIKit equivalents; the launch storyboard stays |
| `www/` launch page that checks the connection | native "can't reach the site" screen with Try again |
| `capacitor.config.json`, `config.xml`, `App/public`, `Main.storyboard` | removed from the iOS project |
| `@capacitor-firebase/messaging` (PR #16) | Firebase iOS SDK called directly, same FCM tokens, same server code |

### What is kept

Bundle id `org.veritasvillage.family`, team `VQUCJB5C7M`, automatic signing,
`App.entitlements` (Associated Domains `webcredentials:family.veritasvillage.org`
for passkeys and saved passwords), icons, launch screen, the transparent
status bar over a navy strip with light text, and the top scroll-edge effect
switched off.

### Android and the web

`mobile/android`, `mobile/capacitor.config.ts` and the `Mobile app` workflow
(`npx cap sync android`) are not touched. The web code still recognises
`window.Capacitor` for Android. The bridge below is written so an Android
frame can follow later: the page-facing protocol, the path configuration and
the web changes are platform-neutral, only the Swift is iOS.

## Shape of the frame

```
FrameController (root)
├─ signed out:  one FrameNavigationController -> sign-in page, no tab bar
└─ signed in:   content area + UITabBar (native control, not a tab bar controller)
                 ├─ tab 1..5   FrameNavigationController -> WebPageController(s)
                 └─ Menu       native sheet (section and destination list)
Sheets: a FrameNavigationController presented as a page sheet, same page controller inside.
```

### Navigation (PR 1)

- Each page is its own `WKWebView` inside a `WebPageController`. Web views
  share one `WKWebsiteDataStore`, so the Supabase session in `localStorage`
  and cookies are shared. Passkeys work as before: it is the same entitlement
  and the same domain.
- A tap on a link, or a script calling `location.assign`, never reaches the
  web view. The navigation delegate cancels it and asks the `Navigator`, which
  reads the **path configuration** (`path-configuration.json`, bundled; later
  fetchable from the site so rules can change without a build) and then pushes
  a new page, replaces the current one, presents a sheet, resets to the sign-in
  page, or opens the link in `SFSafariViewController`.
- Same-page changes (anchors, `history.pushState`) stay in the page.
- Native push animation and the interactive left-edge back-swipe are
  `UINavigationController`'s own.

### Back, popups and inner screens (PR 1)

`lib/back-layers.ts` makes popups, reports, conversations and admin tabs
history entries (`pushState`). The frame uses what WebKit already tracks:

```
back (button or edge swipe) =
    webView.canGoBack ? webView.goBack()   // closes the popup, report or tab: popstate runs back-layers
                      : pop the page
```

No counting bridge is needed: a page starts with an empty history list, so
`canGoBack` is true exactly when the page has an open layer. While it is true
the system pop gesture is refused (`gestureRecognizerShouldBegin`) and the
page's own left-edge recogniser runs `goBack()` instead; the navigation bar's
back button does the same. The web edge-swipe arrow (`lib/swipe-back.ts`) turns
itself off when `data-frame` is set and stays for the home-screen web app.

### Web flag (PR 3)

`WKUserScript` at document start sets `window.VVNative` and
`<html data-frame="ios">`. `PLATFORM_SCRIPT` (which runs in the head, after
that) reads it and sets `data-app`, `data-shell="native"`, `data-platform="ios"`
as before, so existing `html[data-app]` rules keep working. New rules under
`html[data-frame]` hide the web header and web bottom bar. Browsers and the
installed web app never have `window.VVNative`, so none of this reaches them.

### Tab bar and the person's choices (PR 2)

`lib/nav-prefs.ts` stays the single source. A small client component in the
page runs the same `resolveBar()` it runs today and tells the frame, through
the bridge, the roles, the current section, the resolved bar for each section
the person has, the Menu groups, and the unread count (`unread_message_count`,
already polled by `useUnreadCount`). Native draws what it is told and sends
taps back as navigations. The page does not draw its own bar in the frame.

- A standalone `UITabBar` (native control, gets the system's glass look) so six
  items (five choices plus Menu) all show.
- Messages shows a native badge from the unread count.
- Menu opens a native sheet listing the groups from the web, plus Customize
  bottom bar, Account & security, Take the tour and Sign out. Those four run
  the existing web screens: the frame sends an `action` event and the page
  opens the web modal it already has. Customizing stays a web screen, so the
  list of destinations has one definition.
- Signed in or out is also reported by the page, so the frame shows the sign-in
  page with no tab bar and returns to it on sign-out or an expired session.

### Chrome (PR 3)

Native navigation bar per page: title from the page, a bell with its unread
count, and a profile button (account, tour, customize, sign out). The bell
opens a short web page in a sheet (`/family-village/notifications`) that lists
`notifications` rows and pushes `link_path` when one is tapped.

### Native touches (PR 4)

Pull to refresh (`UIRefreshControl`), share sheet for report PDFs (the page
passes the blob to the frame, which writes a temp file and presents
`UIActivityViewController`; `deliverPdf` takes that path when `VVNative`
exists), photo and camera pickers (`PHPickerViewController` and
`UIImagePickerController`, called from the three upload spots), Face ID or
passcode on return to the app (`LocalAuthentication`, with a cover view while
the app is inactive), haptics on key actions, JavaScript alert and confirm
dialogs (Capacitor used to supply these).

### Push (PR 5)

PR #16 already built the server half: `register_device_token`, FCM v1 sending,
`link_path` in the payload. The frame keeps that and changes only the phone
half.

1. The Firebase iOS SDK (`FirebaseMessaging`, Swift package) is added to the
   target. `GoogleService-Info.plist` and the Push Notifications capability
   come from #16. `aps-environment` is **added** to the existing entitlements
   file, next to Associated Domains. #16 replaced that file's contents, which
   is the conflict to resolve.
2. The page asks through the bridge (`push.enable`, `push.disable`,
   `push.status`). Native requests permission, registers with APNs, hands the
   token to Firebase, and returns the FCM token. The web code calls
   `register_device_token` as #16 does. `lib/native.ts` gets one more backend
   (the frame) beside the Capacitor one used on Android.
3. A tap on a notification arrives in `UNUserNotificationCenterDelegate`. The
   frame reads `url` from the payload, runs it through the same safe-path check
   as the server, selects the tab that owns the section, and pushes the page.
   A tap during a cold launch waits until the frame is ready. No web code runs
   for taps, so it also works before the page has loaded.

### Later: Apple Pay for dues

Billing is off. When it turns on, the Stripe iOS SDK goes in a
`Frame/Payments/` folder behind a `pay.dues` bridge message (amount and
Stripe client secret in, result out), and the web dues screen calls it when
`VVNative` exists, falling back to the embedded Stripe form otherwise. Nothing
for it ships now; the folder and message name are reserved here.

## Web changes and the rule they follow

Every web change is inert unless `window.VVNative` exists, which only the
frame creates:

- `lib/platform.ts`: recognise the frame, set `data-frame`.
- `lib/swipe-back.ts`: do nothing when `data-frame` is set.
- later PRs: `html[data-frame]` CSS, a client component that reports state,
  the notifications page, a branch in `deliverPdf` and the three photo spots.

## Testing without signing in

The Simulator can see the sign-in screen and the public pages (`/privacy`,
`/terms`, `/support`, `/delete-account`). A small test page
(`mobile/ios/test-pages/`, served from `localhost`; debug builds only accept
`-VVBaseURL`) exercises push, back-swipe, popups through `pushState`, a sheet,
and the bridge. Signed-in screens are checked by Sam on the phone.

## What is verified

### PR 1: note, navigation core, web flag

Verified in the iOS Simulator (iPhone 17 Pro), debug build, by driving the app and reading
its log (`log show --predicate 'subsystem == "org.veritasvillage.family"'`):

- The app launches with no Capacitor, draws the native navy navigation bar with light status
  text, and loads the production sign-in screen (`/family-village`) in it.
- A link tap is cancelled in the web view and becomes a native push (log: `open ... as push`),
  with the native bar, back chevron and slide animation. Script navigation (`location.assign`)
  goes the same way.
- A page that opens a popup with `history.pushState` flips `canGoBack` to true. The system
  back-swipe is then refused, the left-edge swipe closes the popup and leaves the page on screen,
  and the next swipe pops the page (log shows all three).
- The `sheet` rule opens a native page sheet with grabber and Done button; `replace` and the
  default `push` rules come from `path-configuration.json`.
- External links (`veritasvillage.org`, any other host) open in the system browser sheet;
  `mailto:`/`tel:` leave the app.
- Bridge: `VVNative.call("ping")` gets its reply; `post("title")`, `post("haptic")` and
  `post("log")` arrive; an unknown type rejects the page's promise. The page sees
  `window.VVNative`, `data-frame="ios"` and the `VeritasVillageApp/1` user agent suffix.
- The "can't reach the site" screen appears when a load fails (seen once when the Mac was
  overloaded) and Try again reloads.
- `tsc` is clean. The Release configuration builds.

Not verified here: passkey sign-in (needs the associated-domains entitlement, so a signed build on
a phone), haptics (the Simulator has none), the interactive swipe feel and animation on a real
device, signed-in pages, and the Android build (CI runs it).
