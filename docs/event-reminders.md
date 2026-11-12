# Event reminders

Everyone who can see a calendar event gets a reminder **3 days** and again **1 day** before it, at **9:00 AM Central time**.
All of that can be changed by an administrator (Admin, Integrations, Event reminders).

Code: `supabase/migrations/20261114100000_event_reminders.sql`, `app/family-village/admin/event-reminder-settings-card.tsx`,
the calendar form in `app/family-village/admin/news-tab.tsx`, the toggle in `app/family-village/notification-prefs-section.tsx`.
Tests: `supabase/tests/database/024_event_reminders.test.sql`.

## No second sender

A reminder is a row in `public.notifications` (kind `event_reminder`, linking to `/family-village/calendar`). That is what every
sender already reads: the bell, `deliver-push`, quiet mode, the push and email switches, and the never-contact rules for inactive
and reviewer accounts all apply unchanged. The new job only decides *who is owed what, when*, and writes those rows.

## Who gets one

Exactly the people who can see the event:

| Event audience | Reminded |
| --- | --- |
| Every family / Front page (public) | Every active person |
| Teaching team | Teachers and administrators (both can see these events) |
| One class | That class's teachers, and the adults of families with an **active** enrollment in it. Not administrators, not withdrawn families |

Never: inactive profiles, reviewer (demo) accounts and anyone on the reviewer email domain, reviewer events, people who switched
**Event reminders** off in their notification settings, events whose **Send reminders** switch is off.

## When

For each event and each offset: the event's **local date** minus the offset, at the send time, in America/Chicago.

* A timed event's date is read in Central time (a 10 PM Central event is on that date, though UTC says the next day).
* An all-day event is stored at UTC midnight (or midday, for those a teacher adds), so its date is read in UTC. This is the trap
  the calendar code warns about; the reminder code does it the same way as `lib/calendar.ts`.
* Daylight saving is the database's own time-zone rule: 9:00 AM stays 9:00 AM (15:00 UTC in winter, 14:00 in summer).
* A reminder that would arrive after a timed event starts is not sent (only possible with "0 days before").

## Never twice, never stale

* `event_reminder_log` has one row per (event, offset, event date, person). The job writes it with `on conflict do nothing` and
  notifies only the rows it actually wrote, so a repeat or overlapping run sends nothing.
* The event's **date is part of that key**. An event moved to a new date is reminded for the new date, never again for the old one.
* `events.reminders_from` is set by a trigger when an event is created or its date, time, audience, class or reminder switch
  changes. A reminder due before that moment is skipped: an event added at 10 AM three days before is not sent the 9 AM reminder
  that already passed, but its 1-day reminder still goes. People cannot change `reminders_from` themselves.
* A reminder is only sent within 3 hours after it was due. After an outage nobody receives yesterday's "tomorrow".
* Deleting an event leaves nothing pending.

## One reminder per day, not one per event

A person gets **one** notification per reminder day: three events on the same date become
"Tomorrow: Field trip at 9:00 AM, Potluck at 1:00 PM" (four or more: "Tomorrow: 4 events", each listed in the text). A 3-day and
a 1-day reminder for different dates that land on the same morning are two notifications.

## Important or not? Not

`event_reminder` is **not** in the important list (never texted) and **not** in the email fallback list (never emailed). The email
fallback waits a day for push to be seen, which would deliver a 1-day reminder on the day of the event. Reminders reach people in
the bell and by push. A person with no app installed sees them in the bell only. An administrator who wants email anyway can tick
**Event reminders** under *Email and text fallback*; the existing wait still applies.

## Settings (Admin, Integrations, Event reminders)

| Setting | Default | Notes |
| --- | --- | --- |
| Send event reminders | on | Off stops everything; a reminder missed while off is not sent late |
| Time of day | 9:00 AM Central | Between 6:00 AM and 9:00 PM |
| Days before the event | 3, 1 | One to three numbers, 0 to 30. 0 is the morning of the event |
| Test mode | empty | Emails of the only people who will get reminders while it is not empty |

The card also lists what is coming up in the next three weeks, per event, with how many people each will reach, what already
went, and what was skipped. The same lines appear under each event on the Village calendar tab. A teacher's class events appear in
the card list, and send reminders by default. The teacher's class-date form has no "Send reminders" switch yet; that page is being redesigned separately, so adding the switch there is a small follow-up.

## Try it with a throwaway event (safe)

Use test accounts only.

1. Make two test accounts (one parent, one teacher) and a test class with only them in it, or use ones you already have.
2. Admin, Integrations, Event reminders: put **both test emails in Test mode** and save. Now nobody else can receive a reminder.
3. Add a class event for that class three days from now (or an all-day Village event, which is only safe *because of* test mode).
   Under the event, "3 days before ... goes out ... to N people" shows when it will go out and to how many. With test mode on, only
   your test accounts receive it.
4. At 9:00 AM Central (within five minutes), the test accounts get the bell notification, and a push if installed. Run it again:
   nothing more arrives.
5. Move the event a day later: the schedule under it updates. Turn **Send reminders** off for it: the lines disappear.
6. Clear Test mode when finished.

To see a reminder sooner than three days away (still in test mode): set **Days before the event** to `0`, set **Time of day** a few
minutes ahead, and add an all-day event dated today. Put the settings back to `3, 1` and 9:00 AM afterwards.
