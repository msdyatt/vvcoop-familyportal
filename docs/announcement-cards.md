# Announcement cards follow their news post

A published news post appears in #Announcements (or, for a class post, in that class's channel) as a card: a row in `messages` with `post_id` set. The post is the record. The card follows it.

Code: `supabase/migrations/20261116090000_announcement_card_sync.sql`. Tests: `supabase/tests/database/028_announcement_card_sync.test.sql`. Screen: the card header in `app/family-village/messages/thread.tsx`.

| What happens to the post | What happens to the card |
| --- | --- |
| Headline or text edited | Same card and message id, preview text updated, marked **Edited**. Reactions and "Seen by" stay. |
| Switched between every family and the public site | Nothing to move. Same card. |
| Audience moved to a different channel (class to every family, or back) | Old card removed (shows "Message removed", reactions cleared), new card in the other channel. |
| Teaching team only, or taken back to unpublished | No card. An existing one is removed. |
| Teaching team only back to families, or published again | A card appears. |
| Deleted | Card shows "Message removed" and its reactions are cleared. It no longer turns into an ordinary message from the author. |
| Card removed by an administrator on a report | Stays removed, whatever happens to the post later. |

Nobody is notified by any of these. The bell and push notice for a post still go out once, when it is first published. An edit does not move the channel up the list and does not count as unread.

`messages.body` on a card is only a short preview (headline plus the first 280 characters of the text). The conversation list, notifications and search read it. A later change will make the card show the post itself.

There is at most one card per post (`messages_one_card_per_post`).

A new card made by a move appears at the bottom of its channel and counts as unread there, because for the people in that channel it is new.
