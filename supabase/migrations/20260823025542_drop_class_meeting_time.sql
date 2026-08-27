-- Applied only after the deploy that stops reading these.
--
-- `block_id` and `room_id` replaced both of them. Splitting the drop out of
-- 20260824090000 keeps the live site working during the gap between running the
-- migration and shipping the build that no longer selects these columns --
-- PostgREST fails the whole select when one column in the list is missing, so
-- dropping early would blank the class list for every family.
-- For the record, everything these columns held at the time of the drop:
--   History      meeting_time '9', block_label null
--   Science      meeting_time '9', block_label null
--   Potion Making both null
-- Three rows, one of which said "9". Nothing here is worth a backfill; the
-- co-op's real timetable goes into class_blocks.
alter table public.classes drop column if exists block_label;
alter table public.classes drop column if exists meeting_time;
