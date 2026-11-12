# Scheduled announcements

An administrator writes a news post now and chooses **Publish later**: a date and a time in the co-op's time zone
(America/Chicago, whatever zone the administrator's computer is in). It is saved as *scheduled* and goes out by itself.

Code: `supabase/migrations/20261114090000_scheduled_announcements.sql`, `app/family-village/admin/news-tab.tsx`,
`lib/coop-time.ts`. Tests: `supabase/tests/database/023_scheduled_announcements.test.sql`, `lib/coop-time.test.ts`.

## What "scheduled" means

A post is scheduled when `published_at` is empty and `scheduled_for` has a time. Everything that makes a post visible or
noisy already keys off `published_at`, so a scheduled post is invisible and silent until the moment it is published:

| Thing | Before the time | At the time |
| --- | --- | --- |
| Family, teacher and public-site feeds, attachments | Not visible (row security needs `published_at`) | Visible |
| Card in #Announcements (or the class channel) | None | Posted once |
| Bell and push notification (`post_published`) | None | Sent once |
| Administrators | See it on the News tab with "Scheduled for ..." | |

The bell/push notification used to run only when a post was inserted. It now also runs when `published_at` goes from empty to
a time, which is the only thing a scheduled post does. A post is notified once, however many times it is touched later.

## The publisher

`pg_cron` job `publish-scheduled-posts` runs `private.publish_due_posts()` every minute. It locks each due post
(`for update skip locked`) and re-checks `published_at`, so a retry or two overlapping runs publish a post exactly once.
At most 50 posts per run; any left over go out the next minute. A post that fails to publish is rolled back whole and tried
again the next minute; the others are not held up.

## Rules

* **Who:** administrators only (with two-factor satisfied if they have it). Teachers cannot write news at all today (posts are
  administrator-write), so there is no teacher scheduling. Anyone else gets "Administrator access is required."
* **Times in the past are refused**, in the screen, in the functions and by a database trigger (so a direct table write cannot
  schedule one either). More than a year ahead is refused too, to catch a typo in the year.
* **Edit, reschedule, cancel, publish now** are all available until it goes out. *Cancel schedule* keeps the post as a draft
  (publish it, schedule it again, or delete it); nothing is sent. Any administrator can do these, not only the author.
* **Audit log** (`audit_log`): `news_scheduled`, `news_schedule_edited` (lists what changed: headline, text, audience, time),
  `news_schedule_cancelled`, `news_published` (`by`: `schedule` or `administrator`) and `news_schedule_held`.
* **When the person who scheduled it is gone:** if, at the due time, the person who last set the schedule is no longer an
  active administrator (account removed, suspended or no longer an administrator), the post is **held**, not sent in their
  name. It stays on the News tab marked "Held", every active administrator gets a bell notice (`post_held`), and any
  administrator can publish it, pick a new time (which makes it theirs) or cancel it. A held post is not retried every
  minute and does not notify again.

## Time zone

`lib/coop-time.ts` turns a wall-clock date and time in America/Chicago into the real instant stored in the database, and back.
8:00 AM stays 8:00 AM across the daylight-saving changes. A time that does not exist (2:30 AM the night clocks spring forward)
lands an hour later; one that happens twice (1:30 AM when they fall back) means the first.

## Try it with a throwaway post

Use a test account, not real families. Make sure the audience is yours alone (for example a **Teaching team only** post, with
only your own test teacher account on that list), or run it against a local database.

1. News tab, write a headline and a line of text, choose **Publish later** and a time two minutes from now.
2. It appears under **Waiting to go out** as "Scheduled for ...". Sign in as a family or teacher test account: you do not see it.
3. At the time, within a minute: it moves to the published list, the card appears in #Announcements, the bell notification arrives.
4. Try **Cancel schedule**, **Edit** (change the time), and **Publish now** on other test posts.
