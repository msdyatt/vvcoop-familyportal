-- Urgent broadcasts: one message from an administrator to a chosen audience.
-- ---------------------------------------------------------------------------
-- Builds on the fallback ladder (20261113090000). A broadcast is a notification
-- made for each person in the audience, plus the bookkeeping to say who it was
-- for and whether it reached them:
--
--   * broadcasts / broadcast_recipients / broadcast_acks -- what was sent, to whom,
--     and who tapped "Got it".
--   * broadcast_templates -- saved starting points (weather closure, schedule change, other).
--   * admin_broadcast_preview -- says exactly who would be reached by which channel
--     before anything is sent. Same rules as sending (one shared audience function).
--   * admin_send_broadcast -- administrators only, second factor required, rate limited,
--     idempotent on a request id (a double click sends once), audited. Urgent also needs
--     an explicit confirmation flag.
--   * admin_broadcast_report / admin_broadcast_history -- reached / not reached, by channel.
--   * my_active_urgent_broadcasts / acknowledge_broadcast -- the family-side banner.
--
-- Severity decides how it travels:
--   urgent     every channel the person allows, immediately: push, and email and text queued
--              at once (not after the 24 hour wait). Ignores "only urgent things" mode and
--              blocks. Still respects a channel the person switched off, and never texts
--              without a recorded agreement.
--   important  push first, then the ladder (email after the wait; text for those who agreed).
--   notice     push first, then email for people push cannot reach; follows normal
--              preferences, quiet mode and blocks.
-- Inactive profiles and reviewer (demo) accounts are never in an audience.
-- ---------------------------------------------------------------------------

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  -- Sent by the browser once per composed message; a second send with the same id changes nothing.
  request_id uuid not null unique,
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  severity text not null check (severity in ('urgent', 'important', 'notice')),
  audience jsonb not null,
  audience_label text,
  template_key text,
  recipient_count integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- The banner shows until the person taps "Got it", this time passes, or an administrator ends it.
  active_until timestamptz not null default now() + interval '48 hours',
  ended_at timestamptz,
  ended_by uuid references public.profiles(id) on delete set null
);
create index broadcasts_created_idx on public.broadcasts (created_at desc);

create table public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_id uuid references public.notifications(id) on delete set null,
  primary key (broadcast_id, user_id)
);
create index broadcast_recipients_user_idx on public.broadcast_recipients (user_id);

create table public.broadcast_acks (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

create table public.broadcast_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  severity text not null check (severity in ('urgent', 'important', 'notice')),
  title text not null default '' check (char_length(title) <= 120),
  body text not null default '' check (char_length(body) <= 2000),
  builtin boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

insert into public.broadcast_templates (name, severity, title, body, builtin) values
  ('Weather closure', 'urgent', 'Closed today because of the weather',
   'Veritas Village is closed today because of the weather. Please stay home and stay safe. We will send another message when we know about the next meeting day.', true),
  ('Schedule change', 'important', 'Schedule change',
   'We are changing our schedule. The details are below.', true),
  ('Other', 'notice', '', '', true);

alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.broadcast_acks enable row level security;
alter table public.broadcast_templates enable row level security;
create policy broadcasts_admin_read on public.broadcasts for select to authenticated using (private.has_role('admin'));
create policy broadcast_recipients_admin_read on public.broadcast_recipients for select to authenticated using (private.has_role('admin'));
create policy broadcast_acks_admin_read on public.broadcast_acks for select to authenticated using (private.has_role('admin'));
create policy broadcast_templates_admin_read on public.broadcast_templates for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.broadcasts as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.broadcast_recipients as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.broadcast_acks as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.broadcast_templates as restrictive for all to authenticated using (private.aal_satisfied());
revoke all on public.broadcasts, public.broadcast_recipients, public.broadcast_acks, public.broadcast_templates from public, anon, authenticated;
grant select on public.broadcasts, public.broadcast_recipients, public.broadcast_acks, public.broadcast_templates to authenticated;

-- --- who a broadcast is for -----------------------------------------------------------
-- audience = {"type":"everyone"} | {"type":"class","class_id":"…"} | {"type":"grade","grade":"3"}
--          | {"type":"teachers"} | {"type":"people","user_ids":["…"]}
-- Only active, real profiles. Below urgent, a person who blocked the sender is left out.
create or replace function private.broadcast_audience(p_audience jsonb, p_sender uuid, p_severity text)
returns table (user_id uuid)
language plpgsql stable security definer set search_path to ''
as $function$
declare v_type text := p_audience ->> 'type'; v_ids uuid[];
begin
  if v_type = 'everyone' then
    select coalesce(array_agg(p.id), '{}') into v_ids from public.profiles p;
  elsif v_type = 'teachers' then
    select coalesce(array_agg(distinct r.user_id), '{}') into v_ids from public.user_roles r where r.role = 'teacher';
  elsif v_type = 'class' then
    select coalesce(array_agg(x.u), '{}') into v_ids from (
      select ta.user_id as u from public.teacher_assignments ta where ta.class_id = (p_audience ->> 'class_id')::uuid
      union
      select fm.user_id from public.enrollments e
        join public.children c on c.id = e.child_id and c.active
        join public.family_members fm on fm.family_id = c.family_id
      where e.class_id = (p_audience ->> 'class_id')::uuid and e.status = 'active') x;
  elsif v_type = 'grade' then
    select coalesce(array_agg(distinct fm.user_id), '{}') into v_ids
    from public.children c join public.family_members fm on fm.family_id = c.family_id
    where c.active and c.age_band = (p_audience ->> 'grade');
  elsif v_type = 'people' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(p_audience -> 'user_ids', '[]'::jsonb)) x;
  else
    raise exception 'Choose who should receive this.';
  end if;

  return query
  select p.id from public.profiles p
  where p.id = any (v_ids)
    and p.status = 'active' and not p.is_demo and lower(p.email) not like '%@demo.veritasvillage.org'
    and (p_severity = 'urgent' or p_sender is null
         or not exists (select 1 from public.user_blocks b where b.blocker_id = p.id and b.blocked_id = p_sender));
end;
$function$;

-- A short phrase for the history list: "Everyone", "Class: Latin I", "Grade 3", "Teachers", "3 people".
create or replace function private.broadcast_audience_label(p_audience jsonb)
returns text
language sql stable security definer set search_path to ''
as $function$
  select case p_audience ->> 'type'
    when 'everyone' then 'Everyone'
    when 'teachers' then 'Teachers'
    when 'grade' then 'Grade ' || (p_audience ->> 'grade')
    when 'class' then 'Class: ' || coalesce((select c.title from public.classes c where c.id = (p_audience ->> 'class_id')::uuid), 'unknown')
    when 'people' then jsonb_array_length(coalesce(p_audience -> 'user_ids', '[]'::jsonb)) || ' hand-picked'
    else 'Unknown' end;
$function$;

-- --- preview: exactly who, by which channel -------------------------------------------------
create or replace function public.admin_broadcast_preview(p_audience jsonb, p_severity text)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_notification_admin();
  v_kind text; v_s public.notification_settings%rowtype; v_people uuid[]; v_result jsonb;
begin
  if p_severity not in ('urgent', 'important', 'notice') then raise exception 'Choose a severity.'; end if;
  v_kind := 'broadcast_' || p_severity;
  select * into v_s from public.notification_settings where id = 'ladder';
  select coalesce(array_agg(a.user_id), '{}') into v_people from private.broadcast_audience(p_audience, v_actor, p_severity) a;

  with f as (
    select ca.*,
      (p_severity = 'urgent' or not ca.quiet) as allowed
    from private.channel_access(v_people) ca where ca.active
  ), g as (
    select f.*,
      (f.allowed and f.push_ok) as c_push,
      (f.allowed and f.email_ok and (p_severity = 'urgent' or (v_s.email_fallback_enabled and v_kind = any (v_s.email_fallback_kinds)))) as c_email,
      (f.allowed and f.sms_ok and (p_severity = 'urgent' or v_kind = any (v_s.important_kinds))) as c_sms
    from f
  )
  select jsonb_build_object(
    'total', count(*),
    'push', count(*) filter (where c_push),
    'email_only', count(*) filter (where not c_push and c_email),
    'sms_only', count(*) filter (where not c_push and not c_email and c_sms),
    'unreachable', count(*) filter (where not c_push and not c_email and not c_sms),
    'also_email', count(*) filter (where c_push and c_email),
    'also_sms', count(*) filter (where c_sms and (c_push or c_email)),
    'email', count(*) filter (where c_email),
    'sms', count(*) filter (where c_sms),
    'quiet_held', count(*) filter (where not allowed),
    'immediate', p_severity = 'urgent')
  into v_result from g;
  return v_result;
end;
$function$;

-- --- sending ------------------------------------------------------------------------------------
create or replace function public.admin_send_broadcast(
  p_request_id uuid, p_title text, p_body text, p_severity text, p_audience jsonb,
  p_template_key text default null, p_confirm_urgent boolean default false)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_notification_admin();
  v_existing public.broadcasts%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_kind text;
  v_id uuid;
  v_count integer;
  v_recent integer; v_recent_urgent integer; v_all_recent integer;
begin
  if p_request_id is null then raise exception 'Missing request id.'; end if;

  -- A second click, or a retry after a timeout, finds the first send and changes nothing.
  select * into v_existing from public.broadcasts where request_id = p_request_id;
  if found then
    if v_existing.created_by is distinct from v_actor then raise exception 'That request belongs to someone else.' using errcode = '42501'; end if;
    return jsonb_build_object('broadcast_id', v_existing.id, 'recipients', v_existing.recipient_count, 'duplicate', true);
  end if;

  if p_severity not in ('urgent', 'important', 'notice') then raise exception 'Choose a severity.'; end if;
  if char_length(v_title) not between 1 and 120 then raise exception 'The title needs 1 to 120 characters.'; end if;
  if char_length(v_body) not between 1 and 2000 then raise exception 'The message needs 1 to 2000 characters.'; end if;
  if p_severity = 'urgent' and not coalesce(p_confirm_urgent, false) then
    raise exception 'Confirm that this is an urgent alert before sending.';
  end if;

  -- Rate limits: an administrator cannot flood people, and neither can all of them together.
  select count(*), count(*) filter (where severity = 'urgent') into v_recent, v_recent_urgent
  from public.broadcasts where created_by = v_actor and created_at > now() - interval '1 hour';
  select count(*) into v_all_recent from public.broadcasts where created_at > now() - interval '1 hour';
  if v_recent >= 6 or v_all_recent >= 12 then raise exception 'Too many broadcasts in the last hour. Wait a little, or check the history: it may already have gone out.'; end if;
  if p_severity = 'urgent' and v_recent_urgent >= 3 then raise exception 'Three urgent alerts have already gone out in the last hour. Wait a little, or check the history.'; end if;
  if exists (select 1 from public.broadcasts where title = v_title and body = v_body and created_at > now() - interval '10 minutes') then
    raise exception 'That looks like a copy of a broadcast sent in the last ten minutes. Check the history first.';
  end if;

  v_kind := 'broadcast_' || p_severity;
  select count(*) into v_count from private.broadcast_audience(p_audience, v_actor, p_severity);
  if v_count = 0 then raise exception 'No one would receive this. Check who it is for.'; end if;
  if v_count > 2000 then raise exception 'That is more than 2000 people. Choose a narrower audience.'; end if;

  insert into public.broadcasts (request_id, title, body, severity, audience, audience_label, template_key, recipient_count, created_by, active_until)
  values (p_request_id, v_title, v_body, p_severity, p_audience, private.broadcast_audience_label(p_audience), p_template_key, v_count, v_actor,
          now() + case when p_severity = 'urgent' then interval '48 hours' else interval '0 hours' end)
  returning id into v_id;

  -- One bell notification per person. deliver-push picks these up within a minute.
  with ins as (
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select a.user_id, v_kind, v_title, v_body, '/family-village/home', 'broadcast', v_id
    from private.broadcast_audience(p_audience, v_actor, p_severity) a
    returning id, recipient_user_id)
  insert into public.broadcast_recipients (broadcast_id, user_id, notification_id)
  select v_id, ins.recipient_user_id, ins.id from ins;

  -- Say up front who push cannot reach, so the report shows why.
  insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, reason)
  select r.notification_id, r.user_id, 'push', 1, 'skipped',
    case when ca.quiet and p_severity <> 'urgent' then 'quiet_mode' when not ca.has_device then 'no_device' else 'push_disabled' end
  from public.broadcast_recipients r
  join private.channel_access((select array_agg(x.user_id) from public.broadcast_recipients x where x.broadcast_id = v_id)) ca on ca.user_id = r.user_id
  where r.broadcast_id = v_id and (not ca.push_ok or (ca.quiet and p_severity <> 'urgent'))
  on conflict (notification_id, channel, attempt) do nothing;

  -- Urgent: email and text are queued now, for everyone who allows them. No wait.
  if p_severity = 'urgent' then
    insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, destination)
    select r.notification_id, r.user_id, 'email', 1, 'queued', ca.email
    from public.broadcast_recipients r
    join private.channel_access((select array_agg(x.user_id) from public.broadcast_recipients x where x.broadcast_id = v_id)) ca on ca.user_id = r.user_id
    where r.broadcast_id = v_id and ca.email_ok
    on conflict (notification_id, channel, attempt) do nothing;

    insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, destination)
    select r.notification_id, r.user_id, 'sms', 1, 'queued', ca.phone
    from public.broadcast_recipients r
    join private.channel_access((select array_agg(x.user_id) from public.broadcast_recipients x where x.broadcast_id = v_id)) ca on ca.user_id = r.user_id
    where r.broadcast_id = v_id and ca.sms_ok
    on conflict (notification_id, channel, attempt) do nothing;
  end if;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'broadcast_sent', 'broadcast', v_id::text, jsonb_build_object(
    'severity', p_severity, 'title', v_title, 'audience', p_audience, 'recipients', v_count, 'template', p_template_key));

  return jsonb_build_object('broadcast_id', v_id, 'recipients', v_count, 'duplicate', false);
end;
$function$;

-- Stops the banner for everyone who has not tapped "Got it". Does not recall anything already sent.
create or replace function public.admin_end_broadcast(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_notification_admin();
begin
  update public.broadcasts set ended_at = now(), ended_by = v_actor where id = p_id and ended_at is null;
  if found then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_actor, 'broadcast_ended', 'broadcast', p_id::text, null);
  end if;
end;
$function$;

-- --- templates ------------------------------------------------------------------------------------
create or replace function public.admin_save_broadcast_template(p_name text, p_severity text, p_title text, p_body text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_notification_admin(); v_id uuid;
begin
  if p_severity not in ('urgent', 'important', 'notice') then raise exception 'Choose a severity.'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'Give the template a name of up to 60 characters.'; end if;
  insert into public.broadcast_templates (name, severity, title, body, created_by)
  values (btrim(p_name), p_severity, left(coalesce(p_title, ''), 120), left(coalesce(p_body, ''), 2000), v_actor)
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.admin_delete_broadcast_template(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.require_notification_admin();
  delete from public.broadcast_templates where id = p_id and not builtin;
end;
$function$;

-- --- what happened ------------------------------------------------------------------------------------
-- One row per recipient: did they see it, did they tap "Got it", and how each channel went.
create or replace function private.broadcast_recipient_state(p_broadcast uuid)
returns table (user_id uuid, notification_id uuid, seen boolean, acked boolean, push text, push_reason text,
               email text, email_reason text, sms text, sms_reason text, reached boolean)
language sql stable security definer set search_path to ''
as $function$
  select r.user_id, r.notification_id,
    (n.read_at is not null or n.push_opened_at is not null or k.acked_at is not null) as seen,
    (k.acked_at is not null) as acked,
    pd.status, pd.reason, ed.status, ed.reason, sd.status, sd.reason,
    (n.read_at is not null or n.push_opened_at is not null or k.acked_at is not null
      or 'sent' in (coalesce(pd.status, ''), coalesce(ed.status, ''), coalesce(sd.status, ''))) as reached
  from public.broadcast_recipients r
  left join public.notifications n on n.id = r.notification_id
  left join public.broadcast_acks k on k.broadcast_id = r.broadcast_id and k.user_id = r.user_id
  left join lateral (select d.status, d.reason from public.notification_deliveries d where d.notification_id = r.notification_id and d.channel = 'push' order by d.attempt desc limit 1) pd on true
  left join lateral (select d.status, d.reason from public.notification_deliveries d where d.notification_id = r.notification_id and d.channel = 'email' order by d.attempt desc limit 1) ed on true
  left join lateral (select d.status, d.reason from public.notification_deliveries d where d.notification_id = r.notification_id and d.channel = 'sms' order by d.attempt desc limit 1) sd on true
  where r.broadcast_id = p_broadcast;
$function$;

create or replace function public.admin_broadcast_report(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare v_b public.broadcasts%rowtype; v_result jsonb;
begin
  perform private.require_notification_admin();
  select * into v_b from public.broadcasts where id = p_id;
  if not found then raise exception 'That broadcast does not exist.'; end if;

  with s as (select * from private.broadcast_recipient_state(p_id))
  select jsonb_build_object(
    'id', v_b.id, 'title', v_b.title, 'body', v_b.body, 'severity', v_b.severity, 'audience', v_b.audience_label,
    'created_at', v_b.created_at, 'ended_at', v_b.ended_at,
    'active', (v_b.severity = 'urgent' and v_b.ended_at is null and v_b.active_until > now()),
    'recipients', (select count(*) from s),
    'reached', (select count(*) from s where reached),
    'not_reached', (select count(*) from s where not reached),
    'seen', (select count(*) from s where seen),
    'acked', (select count(*) from s where acked),
    'channels', jsonb_build_object(
      'push', (select coalesce(jsonb_object_agg(st, c), '{}') from (select coalesce(push, 'none') as st, count(*) as c from s group by 1) x),
      'email', (select coalesce(jsonb_object_agg(st, c), '{}') from (select coalesce(email, 'none') as st, count(*) as c from s group by 1) x),
      'sms', (select coalesce(jsonb_object_agg(st, c), '{}') from (select coalesce(sms, 'none') as st, count(*) as c from s group by 1) x)),
    'people', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', y.user_id, 'name', coalesce(nullif(p.display_name, ''), p.email), 'email', p.email,
        'reached', y.reached, 'seen', y.seen, 'acked', y.acked,
        'push', y.push, 'push_reason', y.push_reason, 'email_status', y.email, 'email_reason', y.email_reason,
        'sms', y.sms, 'sms_reason', y.sms_reason) order by y.reached, p.display_name), '[]')
      from (select * from s order by reached, user_id limit 1000) y join public.profiles p on p.id = y.user_id))
  into v_result;
  return v_result;
end;
$function$;

create or replace function public.admin_broadcast_history(p_limit integer default 30)
returns table (id uuid, title text, severity text, audience_label text, created_at timestamptz, sent_by text,
               recipient_count integer, reached bigint, acked bigint, active boolean)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_notification_admin();
  return query
  select b.id, b.title, b.severity, b.audience_label, b.created_at,
    coalesce(nullif(p.display_name, ''), p.email),
    b.recipient_count,
    (select count(*) from private.broadcast_recipient_state(b.id) s where s.reached),
    (select count(*) from private.broadcast_recipient_state(b.id) s where s.acked),
    (b.severity = 'urgent' and b.ended_at is null and b.active_until > now())
  from public.broadcasts b left join public.profiles p on p.id = b.created_by
  order by b.created_at desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
end;
$function$;

-- --- the family side ---------------------------------------------------------------------------------
-- Urgent broadcasts meant for me, still running, that I have not acknowledged.
create or replace function public.my_active_urgent_broadcasts()
returns table (id uuid, title text, body text, created_at timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select b.id, b.title, b.body, b.created_at
  from public.broadcasts b
  join public.broadcast_recipients r on r.broadcast_id = b.id and r.user_id = (select auth.uid())
  where b.severity = 'urgent' and b.ended_at is null and b.active_until > now()
    and not exists (select 1 from public.broadcast_acks k where k.broadcast_id = b.id and k.user_id = (select auth.uid()))
  order by b.created_at desc;
$function$;

create or replace function public.acknowledge_broadcast(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := (select auth.uid()); v_notification uuid;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  select r.notification_id into v_notification from public.broadcast_recipients r where r.broadcast_id = p_id and r.user_id = v_me;
  if not found then raise exception 'That alert was not sent to you.' using errcode = '42501'; end if;
  insert into public.broadcast_acks (broadcast_id, user_id) values (p_id, v_me) on conflict do nothing;
  -- Acknowledging it also clears it from the bell, which stops the email/text ladder too.
  update public.notifications set read_at = now() where id = v_notification and read_at is null;
end;
$function$;

-- --- permissions ----------------------------------------------------------------------------------------
revoke all on function private.broadcast_audience(jsonb, uuid, text) from public, anon, authenticated;
revoke all on function private.broadcast_audience_label(jsonb) from public, anon, authenticated;
revoke all on function private.broadcast_recipient_state(uuid) from public, anon, authenticated;
revoke all on function public.admin_broadcast_preview(jsonb, text) from public, anon;
revoke all on function public.admin_send_broadcast(uuid, text, text, text, jsonb, text, boolean) from public, anon;
revoke all on function public.admin_end_broadcast(uuid) from public, anon;
revoke all on function public.admin_save_broadcast_template(text, text, text, text) from public, anon;
revoke all on function public.admin_delete_broadcast_template(uuid) from public, anon;
revoke all on function public.admin_broadcast_report(uuid) from public, anon;
revoke all on function public.admin_broadcast_history(integer) from public, anon;
revoke all on function public.my_active_urgent_broadcasts() from public, anon;
revoke all on function public.acknowledge_broadcast(uuid) from public, anon;
grant execute on function public.admin_broadcast_preview(jsonb, text) to authenticated;
grant execute on function public.admin_send_broadcast(uuid, text, text, text, jsonb, text, boolean) to authenticated;
grant execute on function public.admin_end_broadcast(uuid) to authenticated;
grant execute on function public.admin_save_broadcast_template(text, text, text, text) to authenticated;
grant execute on function public.admin_delete_broadcast_template(uuid) to authenticated;
grant execute on function public.admin_broadcast_report(uuid) to authenticated;
grant execute on function public.admin_broadcast_history(integer) to authenticated;
grant execute on function public.my_active_urgent_broadcasts() to authenticated;
grant execute on function public.acknowledge_broadcast(uuid) to authenticated;
