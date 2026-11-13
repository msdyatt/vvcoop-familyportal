# Native frame for the iPhone app

The iPhone app used to be one Capacitor web view with nothing native around
it. This note records how it becomes a native frame (tab bar, navigation bar,
push and back-swipe, sheets, pull to refresh, share sheet, Face ID) that still
loads every screen's content from the live site.

Status of each piece is at the end, under "What is verified".

## Decision

**A small custom frame in Swift, with no Capacitor in the iOS target.**
Android keeps its Capacitor shell (including the Stripe plugin) and the PWA is untouched.

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
| `@capacitor-community/stripe` (#67) | Stripe iOS SDK payment sheet behind `pay.sheet` (PR 6, built) |

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
the bridge, the person's bar, the Menu groups and the unread count
(`unread_message_count`, already polled by `useUnreadCount`). Native draws what it
is told and sends taps back as navigations. The page does not draw its own bar in
the frame.

**One bar for the whole app.** Family and Teaching are one portal on the web too now: one main bar
and one flat Menu with Teaching items among the family ones (shown to anyone with a class this school
year or the teacher role, see `lib/teaching-access.ts`). Admin keeps its own bar on the web. In the first
version of the frame the bar followed the page, and on a phone that read as the bar jumping around, so the
frame always uses the person's main ("home") bar. Admin pages are on it if the person puts them there (the
customizer in the frame edits only this bar and offers every destination their roles allow), and are a tap
away in the Menu otherwise. The Menu message is a list of groups: an untitled one with the portal's items and,
for admins, one titled "Admin". Opening a page that is not on the bar pushes it over the current tab, and
the bar does not change. The web and the home-screen app are unchanged.

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

A navy strip behind the status bar (white clock on every page, as the web does in the app), then on every signed-in
page a native copy of the web's header in the section's colours (`HeaderBand.swift`): the logo on the left, the
notification bell with its unread count and the profile button on the right, the page's name under them in a serif, and
the rule along the bottom. Family and Teaching (one look) are the cream page with a terracotta rule,
Admin the navy band with a light terracotta rule and the cream logo (the `--portal-band-*` values in `app/globals.css`).
`AppHeader` tells the frame its title and which section it is (`title` message with `theme`), so a Messages page under
Family stays Family-coloured. A back button joins the row on pushed pages. The system navigation bar is hidden on these
pages and kept on sheets. The web header is hidden by `html[data-frame] .app-header`; the component stays mounted because it
owns the account, tour and notification logic, and the frame calls into it with the same `action` event the Menu uses. The
profile button's menu has Account & security, Customize bottom bar, Take the tour and Sign out. The bell opens
`/family-village/notifications` (a small web page listing the person's `notifications` rows) as a sheet; its path rule
has `links: "frame"`, so tapping a notification closes the sheet and pushes its `link_path` over the page underneath.
The serif is the system one (New York); Playfair Display is a web font the app does not carry.

### Native touches (PR 4, built)

Pull to refresh (`UIRefreshControl`), share sheet for report PDFs (the page
passes the blob to the frame, which writes a temp file and presents
`UIActivityViewController`; `deliverPdf` takes that path when `VVNative`
exists), photo and camera pickers (`PHPickerViewController` and
`UIImagePickerController`, called from the three upload spots), Face ID or
passcode on return to the app (`LocalAuthentication`, with a cover view while
the app is inactive), haptics on key actions, JavaScript alert and confirm
dialogs (Capacitor used to supply these).

### Push (PR 5, built)

PR #16 built the server half (`register_device_token`, FCM v1 sending, `link_path` as `data.url`) with
the Capacitor Firebase plugin on the phone. PR 5 keeps all of that and replaces only the iPhone half, and
it **supersedes #16**: it carries #16's migration (renamed to a current timestamp so `db push` does not see
it as out of order), `fcm.ts`, `deliver-push`, `lib/push.ts`, `lib/native.ts`, the push router, the Android
plugin wiring and `GoogleService-Info.plist`, and leaves out #16's Capacitor iOS changes (view controller,
Package.swift, entitlements overwrite). Close #16 once this merges.

1. The Firebase iOS SDK (`FirebaseMessaging`, Swift package, 12.19.3, the version #16 resolved) is in the
   target. `aps-environment` is added to the entitlements next to Associated Domains and Apple Pay (#16 replaced
   the file's contents, which was the conflict); `UIBackgroundModes: remote-notification` is in Info.plist.
2. `lib/native.ts` treats the frame as a push backend shaped like the Capacitor plugin: `push.status`,
   `push.enable`, `push.token`, `push.disable` over the bridge, and a `pushToken` event when Firebase rotates
   the token. `lib/push.ts` is #16's, unchanged: it calls `register_device_token` and keeps the token.
3. A tap on a notification arrives in `PushManager` (`UNUserNotificationCenterDelegate`). It reads `url`, applies
   the same "only a path on this site" rule as the server and `safeAppPath`, and asks the frame to open it
   over the tab on screen. On a cold launch the frame opens its remembered tab bar first and then the page. A tap
   while signed out waits for sign-in. No web code runs for taps. While the app is open, notifications still show
   as banners.

What Sam still has to do (unchanged from #16): upload the APNs key to Firebase, and put the Firebase
service-account key in Supabase Vault as `FCM_SERVICE_ACCOUNT`. Until then the permission prompt and token
work but nothing is sent. `aps-environment` is `development` for debug builds; Xcode's automatic signing
switches it to `production` when archiving.

### Apple Pay for dues (PR 6, built)

Main's native payment sheet (#66, #67) drives Stripe's sheet through `@capacitor-community/stripe`, which the frame
does not have (Android still does). PR 6 adds the Stripe iOS SDK (`StripePaymentSheet`, `stripe-ios-spm` 26.16.1) in
`Frame/PaymentSheetPresenter.swift` behind a bridge call, `pay.sheet`, which takes what `dues-checkout` already returns
for a native payment (publishable key, PaymentIntent client secret, merchant name) plus the Apple Pay merchant id and the
return URL, and answers `completed`, `canceled` or `failed`. `lib/dues-api.ts` uses it when the frame reports the
`pay.sheet` capability (`window.VVNative.capabilities`), with the same results as the Capacitor path, so the dues screen,
the edge function and Android are unchanged. The amount is decided by the server; card and bank details go into Stripe's
sheet only. `scene(_:openURLContexts:)` hands the `org.veritasvillage.family://stripe-redirect` return (bank linking) to
Stripe. The Apple Pay entitlement and URL scheme from #67 stay in the project. The saved-customer option the Capacitor
call passed is not used: `dues-checkout` returns no ephemeral key, so Stripe's native sheet could not use it anyway.

Verified in the Simulator: the capability is advertised, `pay.sheet` reaches Stripe's SDK, which calls `api.stripe.com`, and
the page gets `failed` back for a made-up secret. Not verified: the real sheet, Apple Pay, a test payment, bank linking
and the return URL (all need the Apple merchant ID and Stripe's Apple Pay certificate from `docs/native-apple-pay-setup.md`,
a signed build with the Apple Pay capability, and a test-mode charge).

## Native Messages (iPhone)

Messages is written in Swift (SwiftUI inside the frame) and reads and writes the same Supabase data as the website, as the signed-in person,
so row-level security decides everything. No database or RPC change. The web page is still there: `-VVNativeMessages NO` (debug builds) and
the "Use the web version" button on the list's error screen show it, and `?web=1` on a Messages link opens the web page instead of the
native screen.

**Session.** The website is the only place that signs in and refreshes, because a refresh token can be used once and a second holder in the
app would sign the web session out. `lib/native-session.ts` (mounted in `AppHeader`, and alone on `/family-village/native-session`) posts
`session` to the frame: the public project URL and publishable key (already in every page) and the short-lived access token. The refresh token
never leaves the web view. The frame keeps the token in memory only (`NativeSession`), and when it has less than a minute left, or the server
answers 401, it emits `session.refresh` and waits for the page's answer. `SessionBroker` keeps a one-pixel, invisible web view on
`/family-village/native-session` while someone is signed in, so there is always a page to answer, even when no web page is open.

**Data.** `SupabaseAPI` is a small URLSession client for PostgREST (tables, RPCs) and Storage (signed links, upload, remove): no SDK. `LiveFeed`
speaks Realtime's Phoenix protocol over a WebSocket for `messages` and `message_reactions` changes (the same subscription the web makes) and
only says "something changed"; `MessagesStore` then refetches, with the web's 30 second poll as the safety net and a refresh when the app
comes to the front. The tab badge counts with `unread_message_count` itself and wins over the number the pages report.

**Routing.** The Messages tab's root is the native list. A link to `/family-village/messages` (a push tap, the notification list, a Menu row)
is intercepted in `Navigator` and opened natively; `?c=<conversation>` opens that conversation. Where Messages is not on the person's bar the
native list is pushed over the tab on screen.

**Look.** `MessagesTheme.swift` has the web's role colours for Light and Dark and the six person tints. The tint for a person is
FNV-1a over the id modulo 6, the same function as `lib/message-colors.ts`, checked to give the same result for the same ids.

**Thread (part 2).** `ThreadView` is the web thread as a native screen: the wash header, bubbles in runs (a run is one person's messages within ten
minutes, same day), day pills, replies with the quoted message, reactions hung on the bubble's corner, @mentions, News and system messages as
full-width cards, edited label, photos in a grid with a full-size viewer, files with a system preview, "Seen by" for staff. Tap a message
for the reaction bar and Reply / Edit / Remove / Report (long-press gives the same in a context menu). The composer is a pill field with an
emoji panel, @mention suggestions, a reply bar, and an edit mode (Edit puts the text in the composer, Send saves it). A conversation covers the
tab bar (`NativeScreenController.hidesTabBar`) so the composer sits above the keyboard. `ThreadStore` does the reads and writes: the same
RPCs and tables as `thread.tsx`, no new ones. Sending photos and files, and editing a channel, are part 3.

**Photos and files, channel details (part 3).** The composer's plus offers Photo Library (the system photo picker, no library permission needed), Take Photo
and Choose File. The same limits as the web: up to 10 per message, documents (PDF, Word, PowerPoint, Excel, CSV) up to 10 MB, photos shrunk to 1600 px
and re-encoded as JPEG before they go, which drops the GPS position and camera details. Each file is uploaded to `messages/<conversation>/<id>-<name>` in
the private bucket and the message is sent with `p_attachments`; if sending fails the uploads are removed again. For people who run a channel (an
administrator, or its creator) the details sheet edits the name, description and who may post (`update_channel`), follows a class
(`set_channel_class`, administrators), adds and removes people (`add_channel_members`, `remove_channel_member`) and archives or restores
(`archive_channel`).

**Reaction icons.** The six reactions are the co-op's own drawings (`ReactionIcons.swift`, the geometry of `reaction-icons.tsx` drawn with a small SVG path
reader and `Canvas`): a flat disc in a brand colour, a cream shape with an ink outline and a gold wash. The database still stores the six emoji. On a bubble they
sit as one cluster on its top corner, as iMessage does (top right on others' messages, top left on yours); a tap shows who reacted.

**Minimum iOS.** The deployment target goes from 15.0 to 16.0 (`NavigationStack`, `scrollDismissesKeyboard`, `UIHostingController.sizingOptions`,
photo picker). Firebase and Stripe both support 16.

Testing without signing in: `mobile/ios/test-pages/README.md` (a local mock Supabase with invented people stands in for the server).

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

### PR 4: native touches

Verified in the Simulator with the test pages: pull to refresh and haptic calls (from PR 1), the share
sheet (`VVNative.call("share")` shows the system sheet with the file, Save to Files, Copy), the lock
screen (debug flag `-VVLockDemo 1` shows it), the Menu's Face ID switch is built but only appears when
the device has a passcode, so it is not visible in the Simulator.
Not verified: Face ID itself, passcode fallback, locking after 30 seconds away (all need a phone), the
camera and photo pickers (WKWebView shows the system sheet for `<input type=file>`; `NSCameraUsageDescription`
is now in Info.plist so Take Photo no longer crashes), and the real report, receipt and CSV downloads
(they now route through `shareBlob` when `VVNative` exists; they need a signed-in session).

### PR 5: push

Verified in the Simulator: Firebase configures at launch without crashing; `push.status` answers `prompt`; `push.enable`
shows the system permission prompt and answers `granted`; a notification sent with `xcrun simctl push` shows as a banner
while the app is open; a notification tap that launches the app (simulated with `-VVSimulatePushTap`, which runs the
same open path) waits for the remembered tab bar and opens the page over the tab on screen. Also found and fixed here:
the Face ID lock fired after a system alert, because the "fresh launch" marker was never cleared.

Not verified: a real APNs delivery and token (the Simulator has no APNs device token, so `push.token` cannot succeed
there), `register_device_token` with a real token, FCM sending (needs Sam's APNs key in Firebase and
`FCM_SERVICE_ACCOUNT` in Supabase Vault), the notification delegate with a real tap, and Android (CI builds it).

### Loading screen, one logo, no sideways scroll

- **Loading screen.** `SplashView` shows the quill mark, "Veritas Village" and "Opening your portal..." on navy from launch
  until the first page has loaded (12 second cap), laid out like `LaunchScreen.storyboard` so the two read as one screen. It
  replaces the web launch page the Capacitor app showed. The project's launch storyboard had still been Capacitor's blank
  placeholder (white with a blue X); it is now navy with the same mark and name.
- **One logo.** Public pages (Privacy, Terms, Support) carry their own logo header. In the frame the native header supplies the
  logo and the back button, so `html[data-frame] .site-header, .public-header-logo` are hidden. A public page opened from the
  sign-in screen is pushed (it used to replace the sign-in page, leaving no way back) and gets the header with the logo and a
  back button but no bell or profile.
- **No sideways scroll.** The page never pans horizontally: `alwaysBounceHorizontal` is off and a horizontal content offset is
  put back to zero natively, and the frame sets `overflow-x: clip` on `html` and `body`. Things meant to scroll sideways (the
  calendar grid, wide tables) scroll inside the page and are not affected. The cause on the real signed-in pages is not
  confirmed (no signed-in session here); debug builds log each page's width against the screen (`width:` lines in the
  frame log) to find it.

**The frame sets its own flags and hides the web header itself.** A signed-in page showed the web header under the native one,
with the web layout (no `data-frame`, no `data-app`) even though the sign-in page had both. The likely cause is React rebuilding
`<html>` after a hydration error on that page, which takes the attributes the head script set. So the injected script (Bridge.swift)
now sets `data-frame`, `data-platform`, `data-shell` and `data-app` itself, puts them back whenever they go missing (and follows
`<html>` if it is replaced), and hides `.app-header`, `.app-tabbar`, `.site-header` and `.public-header-logo` with a style sheet
that is not part of the page's DOM. This also means the frame does not wait for a web deploy to stop doubling the header. The
web CSS rules stay for the other platforms and as a second line. Test page: `test-frame/dup.html` strips the flags and checks.

**The back swipe is the frame's own.** With the system navigation bar hidden (signed-in pages draw their own header), UIKit's built-in
back-swipe stopped working. `FrameNavigationController` now switches it off and runs its own left-edge swipe with a sliding
transition (`SlideBackAnimator`). The page's own edge swipe starts only when something is open inside the page
(`gestureRecognizerShouldBegin` is `hasInPageHistory`); two edge recognizers cannot both win, and the page's used to take the touch
even when it had nothing to close. So: popup, report, conversation or admin tab open, the swipe closes that; otherwise it leaves the page.

## Dark mode (Light / Dark / System)

The person chooses Light, Dark or System in Account settings or the Menu (web, `lib/theme.ts`). The page tells the frame with
`post("theme", { choice, theme })` on every load and whenever the choice changes; the frame ignores the resolved `theme` and uses
`choice` (`Brand.setTheme`, FrameConfig.swift), because System must keep following the phone. It stores the choice in UserDefaults
(`vv.theme`) so the next launch is dressed correctly from the first frame, and sets `overrideUserInterfaceStyle` on the windows
(`.unspecified` for System). The web view follows the same style, so the page's `prefers-color-scheme` agrees with the native bars.

Everything native that was cream or navy is now a dynamic colour role on `Brand` (`canvas`, `ink`, `band`, `surface`, `action`,
`selection`), mirroring the web's role tokens, so UIKit re-colours the navigation bar, tab bar, Menu sheet, the header band and the
failure screen by itself. The status-bar style over a canvas-coloured header is `.default` (dark text on light, light on dark).
`LockupNavy` has a dark-appearance variant (the cream lockup) in the asset catalog. Deliberately left as they were: the splash and
launch screen (navy), the Face ID lock screen (navy), the Safari view controller's navy bar, and the admin header band (a dark band
in both themes). Capability `theme` is advertised so the page can tell a build that knows the message.

Not verified on a device: this was written and syntax-checked, not run on a phone. Check on a phone: toggle Dark in Account
settings and look at the navigation bar, tab bar, Menu sheet and a sheet page; then switch back to System with the phone in Dark.
