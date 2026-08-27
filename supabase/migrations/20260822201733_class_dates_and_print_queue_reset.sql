-- Class dates carry pre-work, and the print queue resets weekly
-- ---------------------------------------------------------------------------
-- Homework and class dates were two separate things to fill in. They collapse
-- into one: a class date says what is being worked on, where, and whether
-- families need to do something before turning up. The separate `assignments`
-- path is retired from the interface -- the table and its policies are left
-- alone rather than dropped, since nothing is gained by deleting them and a
-- future gradebook may want them.
--
-- The print queue grows without bound. Teachers printing several things per
-- class per week lose track of what is still outstanding, so it resets in the
-- early hours of Sunday, after the Friday co-op day.
-- ---------------------------------------------------------------------------

-- A class date that needs something done first. Surfaced to families as a flag
-- on the date, so "bring a shoebox" is visible before the day rather than after.
alter table public.events
  add column if not exists requires_prework boolean not null default false;

comment on column public.events.requires_prework is
  'Class date needs the family to do something beforehand. Flagged in the family portal.';

-- Cleared rather than deleted. The request and its uploaded file survive for
-- reference; only the teacher''s view of the queue is emptied.
alter table public.print_requests
  add column if not exists cleared_at timestamptz;

comment on column public.print_requests.cleared_at is
  'Set by the weekly reset. Rows with a value are hidden from the teacher queue but retained.';

create index if not exists print_requests_open_idx
  on public.print_requests(requested_by_user_id)
  where cleared_at is null;

-- --- weekly reset ----------------------------------------------------------
create extension if not exists pg_cron;

create or replace function public.clear_print_queue()
returns void
language sql
security definer
set search_path to ''
as $function$
  update public.print_requests
  set cleared_at = now()
  where cleared_at is null;
$function$;

comment on function public.clear_print_queue is
  'Empties the teacher-facing print queue. Scheduled for 09:00 UTC on Sundays, which is 4am Central in summer and 3am in winter -- pg_cron schedules in UTC and does not follow daylight saving.';

-- Re-scheduling under the same name replaces the previous entry, so applying
-- this migration twice does not create two jobs.
select cron.unschedule('clear-print-queue')
where exists (select 1 from cron.job where jobname = 'clear-print-queue');

select cron.schedule('clear-print-queue', '0 9 * * 0', $$select public.clear_print_queue()$$);
