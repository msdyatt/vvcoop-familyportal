-- Automatic event reminders: 3 days before and again 1 day before.
-- ---------------------------------------------------------------------------
-- A reminder is an ordinary row in public.notifications (kind 'event_reminder'). That is the one
-- place every sender already reads, so push (deliver-push), the bell, quiet mode, the per-person
-- push/email switches, the never-contact rules for inactive and reviewer accounts and the
-- delivery log all apply with no second sender. Nothing here sends anything itself.
--
-- Who gets one: exactly the people who can see the event.
--   * audience 'public' or 'families'  every active person
--   * audience 'teachers'              teachers and administrators (events_read lets both see it)
--   * audience 'class'                 that class's teachers and the adults of its actively enrolled
--                                      families, and only them (administrators are not added)
-- Never: inactive profiles, reviewer (demo) accounts, reviewer events, anyone who switched
-- "Event reminders" off, events whose "Send reminders" switch is off.
--
-- When: each event is reminded `offsets_days` (default 3 and 1) days before its LOCAL date at
-- `send_time` (default 9:00 AM) in `timezone` (America/Chicago). The local date of a timed event is
-- read in that zone; an all-day event is stored at UTC midnight (or midday), so its date is read in UTC.
-- Daylight saving is handled by the database's own time-zone rules: 9:00 AM stays 9:00 AM.
--
-- Never twice, never stale:
--   * event_reminder_log has one row per (event, offset, event date, person). The runner inserts
--     with ON CONFLICT DO NOTHING and notifies only for the rows it actually inserted, so a repeat
--     or an overlapping run sends nothing. The event DATE is part of the key: an event moved to a
--     new date is reminded for the new date, never again for the old one.
--   * events.reminders_from is when the event last took its current shape (created, or its
--     date/time, audience, class or reminder switch changed). A reminder is only due if its time is
--     after that, so an event created or moved inside a window skips the reminder already past, and a
--     moved event's pending reminders are recomputed from its new date.
--   * A reminder is only sent within 3 hours after it was due. After an outage nobody gets
--     yesterday's "tomorrow".
--   * A deleted event simply has nothing pending (its log rows go with it).
--
-- One notification per person per reminder day and offset, not one per event: three events on the
-- same date become "Tomorrow: A at 9:00 AM, B at 1:00 PM".
--
-- Email: reminders are NOT important. They are not in important_kinds (never texted) and not in
-- email_fallback_kinds (never emailed). The email fallback waits a day for push to be seen, which
-- would land a "tomorrow" reminder on the day itself. Administrators can still tick "Event
-- reminders" under Email and text fallback; nothing here depends on it.
-- ---------------------------------------------------------------------------

-- --- per event ------------------------------------------------------------------------
alter table public.events
  add column if not exists send_reminders boolean not null default true,
  add column if not exists reminders_from timestamptz not null default now();

comment on column public.events.send_reminders is
  'Whether this event gets the automatic 3-day / 1-day reminders. On by default.';
comment on column public.events.reminders_from is
  'When the event last took its current shape (created, or date, time, audience, class or reminder switch changed). A reminder due before this moment is skipped, so an event added or moved inside a reminder window does not send a reminder that is already past. Set by trigger; clients cannot change it.';

create or replace function private.events_reminder_basis()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.reminders_from := now();
  elsif new.starts_at is distinct from old.starts_at or new.all_day is distinct from old.all_day
     or new.audience is distinct from old.audience or new.class_id is distinct from old.class_id
     or new.send_reminders is distinct from old.send_reminders then
    new.reminders_from := now();
  elsif new.reminders_from is distinct from old.reminders_from and current_user in ('authenticated', 'anon') then
    new.reminders_from := old.reminders_from;
  end if;
  return new;
end;
$function$;

drop trigger if exists events_reminder_basis on public.events;
create trigger events_reminder_basis
  before insert or update on public.events
  for each row execute function private.events_reminder_basis();

-- --- administrator settings -------------------------------------------------------------
create table public.event_reminder_settings (
  id text primary key default 'reminders' check (id = 'reminders'),
  enabled boolean not null default true,
  -- Local time of day the reminders go out.
  send_time time not null default '09:00' check (send_time between '06:00' and '21:00'),
  -- How many days before the event (0 = the same morning). Up to three.
  offsets_days integer[] not null default '{3,1}'
    check (cardinality(offsets_days) between 1 and 3 and offsets_days <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]),
  timezone text not null default 'America/Chicago',
  -- Test mode: when not empty, reminders go to these people only, whoever else would get them.
  test_recipients uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.event_reminder_settings (id) values ('reminders') on conflict do nothing;

alter table public.event_reminder_settings enable row level security;
create policy event_reminder_settings_admin_read on public.event_reminder_settings
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.event_reminder_settings as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.event_reminder_settings from public, anon, authenticated;
grant select on public.event_reminder_settings to authenticated, service_role;

-- --- each person's switch ----------------------------------------------------------------
alter table public.notification_preferences
  add column if not exists event_reminders boolean not null default true;

create or replace function public.my_event_reminders()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select coalesce((select np.event_reminders from public.notification_preferences np where np.user_id = (select auth.uid())), true)
  where (select auth.uid()) is not null;
$function$;

create or replace function public.set_my_event_reminders(p_on boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  insert into public.notification_preferences (user_id, event_reminders)
  values ((select auth.uid()), coalesce(p_on, true))
  on conflict (user_id) do update set event_reminders = excluded.event_reminders, updated_at = now();
end;
$function$;

-- --- what has been sent ---------------------------------------------------------------------
create table public.event_reminder_log (
  event_id uuid not null references public.events(id) on delete cascade,
  offset_days integer not null,
  event_date date not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (event_id, offset_days, event_date, user_id)
);
create index event_reminder_log_user_idx on public.event_reminder_log (user_id);

alter table public.event_reminder_log enable row level security;
create policy event_reminder_log_admin_read on public.event_reminder_log
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.event_reminder_log as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.event_reminder_log from public, anon, authenticated;
grant select on public.event_reminder_log to authenticated;

-- --- who can see an event (and wants to hear about it) -----------------------------------------
create or replace function private.event_recipients(p_event_id uuid)
returns table (user_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select p.id
  from public.events e
  join public.profiles p
    on p.status = 'active' and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org'
  where e.id = p_event_id and not e.is_demo
    and coalesce((select np.event_reminders from public.notification_preferences np where np.user_id = p.id), true)
    and (
      e.audience in ('public', 'families')
      or (e.audience = 'teachers' and exists (
            select 1 from public.user_roles r where r.user_id = p.id and r.role in ('teacher', 'admin')))
      or (e.audience = 'class' and e.class_id is not null and (
            exists (select 1 from public.teacher_assignments ta where ta.class_id = e.class_id and ta.user_id = p.id)
            or exists (
              select 1 from public.enrollments en
              join public.children c on c.id = en.child_id
              join public.family_members fm on fm.family_id = c.family_id
              where en.class_id = e.class_id and en.status = 'active' and fm.user_id = p.id)))
    );
$function$;

-- --- when each reminder is due -----------------------------------------------------------------
-- One row per (event, offset) whose send time falls in the range. `skipped` marks a reminder that
-- must not go out: it was already past when the event took its current shape, or (for a timed
-- event) it would arrive after the event began.
create or replace function private.event_reminder_plan(p_from timestamptz, p_to timestamptz)
returns table (event_id uuid, offset_days integer, event_date date, due_at timestamptz, skipped boolean)
language sql stable security definer set search_path to ''
as $function$
  select e.id, o.off, d.event_date, due.due_at,
    (due.due_at < e.reminders_from or (not e.all_day and due.due_at >= e.starts_at))
  from public.events e
  cross join (select * from public.event_reminder_settings where id = 'reminders') s
  cross join lateral unnest(s.offsets_days) as o(off)
  cross join lateral (
    select case when e.all_day then (e.starts_at at time zone 'UTC')::date
                else (e.starts_at at time zone s.timezone)::date end as event_date) d
  cross join lateral (
    select ((d.event_date - o.off)::timestamp + s.send_time) at time zone s.timezone as due_at) due
  where e.send_reminders and not e.is_demo
    and due.due_at >= p_from and due.due_at <= p_to;
$function$;

-- Who is owed a reminder right now. Test mode narrows it to the listed people.
create or replace function private.event_reminder_due(p_now timestamptz, p_window interval default interval '3 hours')
returns table (event_id uuid, offset_days integer, event_date date, user_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select pl.event_id, pl.offset_days, pl.event_date, r.user_id
  from private.event_reminder_plan(p_now - p_window, p_now) pl
  cross join lateral private.event_recipients(pl.event_id) r
  cross join (select test_recipients from public.event_reminder_settings where id = 'reminders') s
  where not pl.skipped
    and (cardinality(s.test_recipients) = 0 or r.user_id = any (s.test_recipients));
$function$;

-- --- the runner -----------------------------------------------------------------------------------
-- Every five minutes. Logs first (the unique key decides who is new), then notifies exactly the
-- people it just logged, grouped per person per reminder day.
create or replace function private.run_event_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare v public.event_reminder_settings; v_logged integer; v_notified integer;
begin
  select * into v from public.event_reminder_settings where id = 'reminders';
  if not found or not v.enabled then
    return jsonb_build_object('disabled', true, 'reminders', 0, 'notifications', 0);
  end if;

  with due as (select * from private.event_reminder_due(p_now)),
  fresh as (
    insert into public.event_reminder_log (event_id, offset_days, event_date, user_id, sent_at)
    select d.event_id, d.offset_days, d.event_date, d.user_id, p_now from due d
    on conflict do nothing
    returning event_id, offset_days, event_date, user_id),
  lines as (
    select f.user_id, f.offset_days, f.event_date, e.id as event_id, e.all_day, e.starts_at, e.title,
      e.title || case when e.all_day then '' else ' at ' || to_char(e.starts_at at time zone v.timezone, 'FMHH12:MI AM') end as label,
      case when coalesce(btrim(e.location), '') <> '' then ' (' || btrim(e.location) || ')' else '' end as place
    from fresh f join public.events e on e.id = f.event_id),
  grp as (
    select l.user_id, l.offset_days, l.event_date, count(*) as n,
      (array_agg(l.event_id order by not l.all_day, l.starts_at, l.title))[1] as first_event,
      string_agg(l.label, ', ' order by not l.all_day, l.starts_at, l.title) as labels,
      string_agg(l.label || l.place, E'\n' order by not l.all_day, l.starts_at, l.title) as detail
    from lines l group by l.user_id, l.offset_days, l.event_date),
  ins as (
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select g.user_id, 'event_reminder',
      left(case g.offset_days when 0 then 'Today' when 1 then 'Tomorrow' else 'In ' || g.offset_days || ' days' end
           || ': ' || case when g.n > 3 then g.n || ' events' else g.labels end, 200),
      left(to_char(g.event_date, 'FMDay, FMMonth FMDD') || E'\n' || g.detail, 400),
      '/family-village/calendar', 'event', g.first_event
    from grp g
    returning 1)
  select (select count(*) from fresh), (select count(*) from ins) into v_logged, v_notified;

  return jsonb_build_object('disabled', false, 'reminders', v_logged, 'notifications', v_notified);
end;
$function$;

-- --- what the administrator controls ----------------------------------------------------------------
create or replace function public.admin_update_event_reminder_settings(
  p_enabled boolean, p_send_time time, p_offsets integer[], p_test_emails text[])
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_notification_admin();
  v_offsets integer[];
  v_emails text[];
  v_users uuid[];
  v_unknown text[];
begin
  if p_send_time is null or p_send_time < '06:00' or p_send_time > '21:00' then
    raise exception 'Choose a time between 6:00 AM and 9:00 PM.';
  end if;
  select coalesce(array_agg(distinct x order by x desc), '{}') into v_offsets from unnest(coalesce(p_offsets, '{}')) x where x is not null;
  if cardinality(v_offsets) not between 1 and 3 or exists (select 1 from unnest(v_offsets) x where x not between 0 and 30) then
    raise exception 'Choose one to three reminders, each 0 to 30 days before.';
  end if;

  select coalesce(array_agg(distinct lower(btrim(x))), '{}') into v_emails from unnest(coalesce(p_test_emails, '{}')) x where btrim(coalesce(x, '')) <> '';
  if cardinality(v_emails) > 20 then raise exception 'Test mode takes at most 20 people.'; end if;
  select coalesce(array_agg(p.id), '{}') into v_users from public.profiles p where lower(p.email) = any (v_emails);
  select array_agg(e) into v_unknown from unnest(v_emails) e where not exists (select 1 from public.profiles p where lower(p.email) = e);
  if v_unknown is not null then
    raise exception 'No one has the email %.', array_to_string(v_unknown, ', ');
  end if;

  update public.event_reminder_settings set
    enabled = coalesce(p_enabled, true), send_time = p_send_time, offsets_days = v_offsets,
    test_recipients = v_users, updated_at = now(), updated_by = v_actor
  where id = 'reminders';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'event_reminder_settings_updated', 'event_reminder_settings', 'reminders',
    jsonb_build_object('enabled', coalesce(p_enabled, true), 'send_time', p_send_time, 'offsets_days', v_offsets, 'test_mode_people', cardinality(v_users)));
end;
$function$;

-- The settings screen reads the emails behind the test-mode list (the table holds ids).
create or replace function public.admin_event_reminder_test_emails()
returns text[]
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_notification_admin();
  return (select coalesce(array_agg(p.email order by p.email), '{}')
          from public.profiles p, public.event_reminder_settings s
          where s.id = 'reminders' and p.id = any (s.test_recipients));
end;
$function$;

-- What will go out, and when: the next `p_days` days, plus the last two days for what already did.
-- p_now is for the tests; the screen leaves it alone.
create or replace function public.admin_upcoming_event_reminders(p_days integer default 21, p_now timestamptz default now())
returns table (event_id uuid, event_title text, class_title text, event_date date, offset_days integer,
               send_at timestamptz, send_label text, recipients integer, status text)
language plpgsql stable security definer set search_path to ''
as $function$
declare v_tz text;
begin
  perform private.require_notification_admin();
  select s.timezone into v_tz from public.event_reminder_settings s where s.id = 'reminders';
  return query
  select pl.event_id, e.title, c.title, pl.event_date, pl.offset_days, pl.due_at,
    to_char(pl.due_at at time zone v_tz, 'FMDy, FMMon FMDD "at" FMHH12:MI AM'),
    case when l.sent > 0 then l.sent else (select count(*)::int from private.event_recipients(pl.event_id)) end,
    case when l.sent > 0 then 'sent' when pl.skipped then 'skipped' when pl.due_at > p_now then 'scheduled' else 'not_sent' end
  from private.event_reminder_plan(p_now - interval '2 days', p_now + make_interval(days => greatest(1, least(coalesce(p_days, 21), 90)))) pl
  join public.events e on e.id = pl.event_id
  left join public.classes c on c.id = e.class_id
  left join lateral (
    select count(*)::int as sent from public.event_reminder_log x
    where x.event_id = pl.event_id and x.offset_days = pl.offset_days and x.event_date = pl.event_date) l on true
  order by pl.due_at, e.title;
end;
$function$;

-- --- access ----------------------------------------------------------------------------------------
revoke all on function private.events_reminder_basis() from public, anon, authenticated;
revoke all on function private.event_recipients(uuid) from public, anon, authenticated;
revoke all on function private.event_reminder_plan(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.event_reminder_due(timestamptz, interval) from public, anon, authenticated;
revoke all on function private.run_event_reminders(timestamptz) from public, anon, authenticated;

revoke all on function public.my_event_reminders() from public, anon;
revoke all on function public.set_my_event_reminders(boolean) from public, anon;
revoke all on function public.admin_update_event_reminder_settings(boolean, time, integer[], text[]) from public, anon;
revoke all on function public.admin_event_reminder_test_emails() from public, anon;
revoke all on function public.admin_upcoming_event_reminders(integer, timestamptz) from public, anon;
grant execute on function public.my_event_reminders() to authenticated;
grant execute on function public.set_my_event_reminders(boolean) to authenticated;
grant execute on function public.admin_update_event_reminder_settings(boolean, time, integer[], text[]) to authenticated;
grant execute on function public.admin_event_reminder_test_emails() to authenticated;
grant execute on function public.admin_upcoming_event_reminders(integer, timestamptz) to authenticated;

-- --- schedule ---------------------------------------------------------------------------------------
create extension if not exists pg_cron;

select cron.unschedule('event-reminders')
where exists (select 1 from cron.job where jobname = 'event-reminders');

select cron.schedule('event-reminders', '*/5 * * * *', $$ select private.run_event_reminders(); $$);
