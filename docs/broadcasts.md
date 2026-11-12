# Urgent broadcasts

Admin, Broadcasts: write a message, choose who it is for, preview exactly who will be reached and by what, send it,
then watch the delivery report. Built on the fallback ladder (`docs/notification-ladder.md`).

Code: `supabase/migrations/20261113120000_broadcasts.sql`, `app/family-village/admin/broadcasts-tab.tsx`,
`app/family-village/urgent-banner.tsx`, `lib/broadcast.ts`. Tests: `supabase/tests/database/022_broadcasts.test.sql`,
`lib/broadcast.test.ts`, and the urgent cases in `supabase/functions/_shared/fcm.test.ts`.

## Severity decides how it travels

| | Urgent | Important | Notice |
| --- | --- | --- | --- |
| Push | at once | at once | at once |
| Email | queued at once for everyone who allows email | after the wait (24 h) if unseen | for people push cannot reach; otherwise after the wait |
| Text | queued at once, only for people who agreed | after the wait, only for people who agreed | never |
| "Only urgent things" mode | ignored | respected | respected |
| Blocks (person blocked the sender) | ignored | respected | respected |
| Banner with "Got it" | yes, until tapped, ended, or 48 hours | no | no |
| iOS interruption level | time-sensitive | normal | normal |
| Android channel | `urgent` (high importance) | default | default |

Urgent still respects a channel the person switched off, never reaches an inactive profile or a reviewer account, and never
texts a number without a recorded agreement. Urgent email goes out even if the admin turned the general email fallback off.

## Audience

Everyone, a class (families with an active child enrolled, plus the class's teachers), a grade (parents of active children
whose grade is that value), all teachers, or hand-picked people. Withdrawn enrollments are left out. Not-returning
households are not filtered out: a closure alert reaching someone it didn't need to is better than missing someone.

## Safeguards

- Admin only, and the second factor must be done if the admin has one (same check as the dues and rollover functions).
- One request id per composed message: pressing Send twice, or retrying after a timeout, sends once.
- Limits per hour: 6 broadcasts per administrator, 3 of them urgent, 12 across all administrators. The same title and body
  within ten minutes is refused. More than 2000 recipients is refused.
- Urgent needs a typed confirmation in the screen and an explicit flag on the database call.
- The preview must match the current audience and severity before Send is enabled.
- Every send and every "end the alert" is in the audit log.

## Delivery report

Each broadcast shows reached / not reached, tapped Got it (urgent), a count by channel (sent, failed, skipped, waiting), and a
list of the people not reached with the reason for each channel (no app, push turned off, email off, no text agreement, send failed).
"Reached" means the provider accepted a message on some channel, or the person opened it in the app.

## Apple: Time Sensitive Notifications (Sam does this once)

The iOS app asks for the capability in `mobile/ios/App/App/App.entitlements`
(`com.apple.developer.usernotifications.time-sensitive`). Apple only signs a build that has it if the App ID has it too.

1. developer.apple.com, Certificates, Identifiers & Profiles, Identifiers, `org.veritasvillage.family`.
2. Tick **Time Sensitive Notifications** (next to Push Notifications and Apple Pay), Save.
3. Xcode, target App, Signing & Capabilities: it should show **Time Sensitive Notifications** with no red errors. Automatic
   signing refreshes the profile. If you sign by hand, regenerate the provisioning profile.
4. Archive and upload as usual.

Until a build with the capability is installed, urgent pushes still arrive on iPhone as ordinary notifications. The
`interruption-level` key is ignored by an app without the entitlement. Email, text and the in-app banner don't depend on it.

People can still turn off Time Sensitive for the app in iPhone Settings, Notifications, Veritas Village.

## Android

`MainActivity` creates a high-importance channel called `urgent` ("Urgent alerts") on launch. Urgent pushes name that channel.
A phone that has never opened the updated app has no channel yet, so the first urgent push there arrives on the default
channel. Nothing for Sam to do.

## Trying it safely

Nothing here has been sent to a real person. For the first real test (after this is merged and deployed):

1. Make sure your own account is the only one that can receive it: send an Urgent broadcast to **Hand-picked people**, choosing
   only yourself. The preview should read "1 person".
2. For a dry run of the email and text sender without touching anyone, set `DELIVERY_ALLOWLIST` on `deliver-notifications`
   to your own email and number, send, then remove it.
3. Check: the bell has it, the banner shows, Got it clears it, the report shows you as reached and tapped Got it.
