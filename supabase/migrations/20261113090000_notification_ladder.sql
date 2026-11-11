-- Notification fallback ladder: push first, then email, then text.
-- ---------------------------------------------------------------------------
-- Until now a notification reached a person two ways only: the bell, and a push
-- to a device they had installed. A parent who never installs the app, or who
-- turned push off, simply never found out. This adds the layer underneath:
--
--   * notification_preferences -- per person: push on/off, email on/off, text on/off,
--     and a "quiet" switch. No row = the defaults (push on, email on, text off).
--   * SMS consent -- a phone number only counts once the person ticked the consent
--     box. The number, the time, the wording they saw and how they agreed are kept
--     (sms_consent_log is append-only). Nothing is ever texted without it.
--   * notification_deliveries -- the delivery log: one row per notification, channel and
--     attempt, with status, provider message id and error.
--   * notification_settings -- how long push gets before email (24 h), which kinds of
--     notification count as "important" (text is only for those), and which get the
--     email fallback at all. Administrators can change all of it.
--   * run_notification_ladder() -- every 15 minutes, finds important notifications that
--     nobody has seen and queues the next channel. Safe to run twice: the unique key
--     on (notification, channel, attempt) means a second run inserts nothing.
--   * claim_deliveries() / finish_delivery() -- how the deliver-notifications edge
--     function takes queued rows, re-checks every rule at the moment of sending, and
--     reports back.
--
-- "Seen" means the person read it in the bell (read_at) or tapped the push
-- notification (push_opened_at). Either one stops the ladder.
--
-- Who is never contacted, on any channel: profiles that are not active, reviewer (demo)
-- accounts, and anyone who switched that channel off. Muted conversations stay muted.
-- ---------------------------------------------------------------------------

-- --- seen -----------------------------------------------------------------------
alter table public.notifications add column if not exists push_opened_at timestamptz;

-- The person tapped the push notification, so they have seen it. Only the
-- recipient can say so, and only this one column changes (the update guard on
-- notifications leaves it alone).
create or replace function public.record_notification_open(p_notification_id uuid)
returns void
language sql security definer set search_path to ''
as $function$
  update public.notifications
  set push_opened_at = now()
  where id = p_notification_id and recipient_user_id = (select auth.uid()) and push_opened_at is null;
$function$;

-- --- administrator settings ----------------------------------------------------
create table public.notification_settings (
  id text primary key default 'ladder' check (id = 'ladder'),
  -- How long push gets before the next channel. Someone with no usable push
  -- device does not wait at all.
  fallback_hours integer not null default 24 check (fallback_hours between 1 and 168),
  -- Extra wait before a text, after the email is due (0 = at the same time).
  sms_extra_hours integer not null default 0 check (sms_extra_hours between 0 and 168),
  -- Text messages are only ever sent for these kinds of notification.
  important_kinds text[] not null default array['broadcast_urgent', 'broadcast_important'],
  -- These kinds get the email fallback (important ones usually belong in both lists).
  email_fallback_kinds text[] not null default array['broadcast_urgent', 'broadcast_important', 'broadcast_notice'],
  email_fallback_enabled boolean not null default true,
  -- Master switch for text messages. Off until the co-op has a texting account.
  sms_enabled boolean not null default false,
  -- Which provider sends texts. 'stub' sends nothing (see _shared/sms.ts).
  sms_provider text not null default 'stub' check (sms_provider ~ '^[a-z0-9_]{1,30}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.notification_settings (id) values ('ladder') on conflict do nothing;

alter table public.notification_settings enable row level security;
create policy notification_settings_admin_read on public.notification_settings
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.notification_settings as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.notification_settings from public, anon, authenticated;
grant select on public.notification_settings to authenticated;
grant select on public.notification_settings to service_role;

create or replace function private.require_notification_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;

create or replace function public.admin_update_notification_settings(
  p_fallback_hours integer, p_sms_extra_hours integer, p_important_kinds text[],
  p_email_fallback_kinds text[], p_email_fallback_enabled boolean, p_sms_enabled boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_notification_admin();
begin
  if p_fallback_hours is null or p_fallback_hours not between 1 and 168 then
    raise exception 'Choose between 1 and 168 hours.';
  end if;
  if p_sms_extra_hours is null or p_sms_extra_hours not between 0 and 168 then
    raise exception 'The extra wait for texts must be between 0 and 168 hours.';
  end if;
  if exists (select 1 from unnest(coalesce(p_important_kinds, '{}') || coalesce(p_email_fallback_kinds, '{}')) k where k !~ '^[a-z_]{1,40}$') then
    raise exception 'That is not a valid kind of notification.';
  end if;

  update public.notification_settings set
    fallback_hours = p_fallback_hours,
    sms_extra_hours = p_sms_extra_hours,
    important_kinds = (select coalesce(array_agg(distinct k order by k), '{}') from unnest(coalesce(p_important_kinds, '{}')) k),
    email_fallback_kinds = (select coalesce(array_agg(distinct k order by k), '{}') from unnest(coalesce(p_email_fallback_kinds, '{}')) k),
    email_fallback_enabled = coalesce(p_email_fallback_enabled, true),
    sms_enabled = coalesce(p_sms_enabled, false),
    updated_at = now(), updated_by = v_actor
  where id = 'ladder';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'notification_settings_updated', 'notification_settings', 'ladder', jsonb_build_object(
    'fallback_hours', p_fallback_hours, 'sms_extra_hours', p_sms_extra_hours,
    'important_kinds', to_jsonb(p_important_kinds), 'email_fallback_kinds', to_jsonb(p_email_fallback_kinds),
    'email_fallback_enabled', p_email_fallback_enabled, 'sms_enabled', p_sms_enabled));
end;
$function$;

-- --- each person's preferences ----------------------------------------------------
create table public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default false,
  -- "Only urgent alerts": routine notifications stay in the bell. Urgent ones ignore it.
  quiet_mode boolean not null default false,
  -- The number texts go to, in +15555550123 form, and the proof they agreed to receive them.
  sms_phone text check (sms_phone ~ '^\+[1-9][0-9]{7,14}$'),
  sms_consent_at timestamptz,
  sms_consent_method text check (sms_consent_method in ('account_settings_checkbox', 'admin_recorded', 'paper_form', 'keyword_reply')),
  sms_consent_wording text,
  sms_opted_out_at timestamptz,
  updated_at timestamptz not null default now(),
  -- The rule that matters most: a text can only be switched on with a number and a recorded agreement.
  constraint sms_needs_consent check (
    not sms_enabled or (sms_phone is not null and sms_consent_at is not null and sms_consent_method is not null and sms_opted_out_at is null))
);

alter table public.notification_preferences enable row level security;
create policy notification_preferences_own_read on public.notification_preferences
  for select to authenticated using (user_id = (select auth.uid()));
create policy aal2_required on public.notification_preferences as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.notification_preferences from public, anon, authenticated;
grant select on public.notification_preferences to authenticated;
grant select on public.notification_preferences to service_role;

-- Every agreement and every opt-out, for good: if a carrier ever asks "show me how
-- this number agreed", this is the answer. Written only by the functions below.
create table public.sms_consent_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  phone text not null,
  action text not null check (action in ('opt_in', 'opt_out')),
  method text not null,
  wording_version text,
  wording text,
  created_at timestamptz not null default now()
);
create index sms_consent_log_user_idx on public.sms_consent_log (user_id, created_at desc);
create index sms_consent_log_phone_idx on public.sms_consent_log (phone);

alter table public.sms_consent_log enable row level security;
create policy sms_consent_log_own_read on public.sms_consent_log
  for select to authenticated using (user_id = (select auth.uid()) or private.has_role('admin'));
create policy aal2_required on public.sms_consent_log as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.sms_consent_log from public, anon, authenticated;
grant select on public.sms_consent_log to authenticated;

-- The exact words a person agrees to. The settings screen fetches them from here, so the
-- wording on screen and the wording on record cannot drift apart. A change of wording is a
-- new version, never an edit to an old one.
create or replace function public.sms_consent_wording()
returns jsonb
language sql immutable set search_path to ''
as $function$
  select jsonb_build_object('version', 'v1', 'text',
    'Yes, text me important alerts from Veritas Village (for example a closure because of weather) at this number. ' ||
    'Expect only a few messages a year. Message and data rates may apply. Reply STOP to stop and HELP for help. ' ||
    'Agreeing is optional and you can turn it off here at any time.');
$function$;

create or replace function private.normalize_phone(p_phone text)
returns text
language plpgsql immutable set search_path to ''
as $function$
declare v_digits text;
begin
  if p_phone is null then return null; end if;
  v_digits := regexp_replace(p_phone, '[^0-9]', '', 'g');
  if btrim(p_phone) like '+%' then
    return case when v_digits ~ '^[1-9][0-9]{7,14}$' then '+' || v_digits end;
  end if;
  if v_digits ~ '^[2-9][0-9]{9}$' then return '+1' || v_digits; end if;
  if v_digits ~ '^1[2-9][0-9]{9}$' then return '+' || v_digits; end if;
  return null;
end;
$function$;

create or replace function public.my_notification_preferences()
returns table (push_enabled boolean, email_enabled boolean, sms_enabled boolean, quiet_mode boolean, sms_phone text, sms_consent_at timestamptz, sms_opted_out_at timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select coalesce(np.push_enabled, true), coalesce(np.email_enabled, true), coalesce(np.sms_enabled, false),
         coalesce(np.quiet_mode, false), np.sms_phone, np.sms_consent_at, np.sms_opted_out_at
  from (select 1) one
  left join public.notification_preferences np on np.user_id = (select auth.uid())
  where (select auth.uid()) is not null;
$function$;

create or replace function public.set_my_notification_preferences(p_push boolean, p_email boolean, p_quiet boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  insert into public.notification_preferences (user_id, push_enabled, email_enabled, quiet_mode)
  values ((select auth.uid()), coalesce(p_push, true), coalesce(p_email, true), coalesce(p_quiet, false))
  on conflict (user_id) do update
    set push_enabled = excluded.push_enabled, email_enabled = excluded.email_enabled,
        quiet_mode = excluded.quiet_mode, updated_at = now();
end;
$function$;

-- Agreeing (p_agree = true) needs a valid number; the agreement, the time and the words
-- shown are recorded. Withdrawing (false) switches texts off and records that too.
create or replace function public.set_my_sms_consent(p_phone text, p_agree boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_phone text;
  v_wording jsonb := public.sms_consent_wording();
  v_current text;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;
  if coalesce(p_agree, false) then
    v_phone := private.normalize_phone(p_phone);
    if v_phone is null then raise exception 'Enter a mobile number with its area code, like (555) 555-0123.'; end if;
    insert into public.notification_preferences (user_id, sms_enabled, sms_phone, sms_consent_at, sms_consent_method, sms_consent_wording, sms_opted_out_at)
    values (v_me, true, v_phone, now(), 'account_settings_checkbox', v_wording ->> 'version', null)
    on conflict (user_id) do update
      set sms_enabled = true, sms_phone = excluded.sms_phone, sms_consent_at = excluded.sms_consent_at,
          sms_consent_method = excluded.sms_consent_method, sms_consent_wording = excluded.sms_consent_wording,
          sms_opted_out_at = null, updated_at = now();
    insert into public.sms_consent_log (user_id, phone, action, method, wording_version, wording)
    values (v_me, v_phone, 'opt_in', 'account_settings_checkbox', v_wording ->> 'version', v_wording ->> 'text');
  else
    select sms_phone into v_current from public.notification_preferences where user_id = v_me and sms_enabled;
    update public.notification_preferences
    set sms_enabled = false, sms_opted_out_at = now(), updated_at = now()
    where user_id = v_me and sms_enabled;
    if v_current is not null then
      insert into public.sms_consent_log (user_id, phone, action, method) values (v_me, v_current, 'opt_out', 'account_settings_checkbox');
    end if;
  end if;
end;
$function$;

-- A texting provider reports a STOP (the person replied STOP to a text). Service role only.
-- The carrier already stops delivering to that number; this keeps our side in step. Returns
-- how many people were switched off. HELP needs no record; the provider answers it.
create or replace function public.record_sms_opt_out(p_phone text, p_method text default 'stop_reply')
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare v_phone text := private.normalize_phone(p_phone); v_row record; v_count integer := 0;
begin
  if v_phone is null then return 0; end if;
  for v_row in
    select user_id from public.notification_preferences where sms_phone = v_phone and sms_enabled for update
  loop
    update public.notification_preferences set sms_enabled = false, sms_opted_out_at = now(), updated_at = now() where user_id = v_row.user_id;
    insert into public.sms_consent_log (user_id, phone, action, method) values (v_row.user_id, v_phone, 'opt_out', coalesce(p_method, 'stop_reply'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- --- who can be reached how -----------------------------------------------------------
-- The one place the rules live. Profiles that are not active and reviewer (demo) accounts
-- are never reachable on any channel. p_users = null means everyone.
create or replace function private.channel_access(p_users uuid[] default null)
returns table (user_id uuid, active boolean, push_ok boolean, has_device boolean, email_ok boolean, email text, sms_ok boolean, phone text, quiet boolean)
language sql stable security definer set search_path to ''
as $function$
  select p.id,
    a.active,
    a.active and coalesce(np.push_enabled, true) and d.has_device,
    d.has_device,
    a.active and coalesce(np.email_enabled, true) and coalesce(btrim(p.email), '') <> '',
    nullif(btrim(p.email), ''),
    a.active and (select s.sms_enabled from public.notification_settings s where s.id = 'ladder')
      and coalesce(np.sms_enabled, false) and np.sms_phone is not null and np.sms_consent_at is not null
      and np.sms_consent_method is not null and np.sms_opted_out_at is null,
    np.sms_phone,
    coalesce(np.quiet_mode, false)
  from public.profiles p
  left join public.notification_preferences np on np.user_id = p.id
  cross join lateral (select p.status = 'active' and not p.is_demo and lower(p.email) not like '%@demo.veritasvillage.org' as active) a
  cross join lateral (select exists (select 1 from public.push_subscriptions ps where ps.user_id = p.id) as has_device) d
  where p_users is null or p.id = any (p_users);
$function$;

-- The edge functions (service role) ask through this wrapper.
create or replace function public.channel_access_for(p_users uuid[])
returns table (user_id uuid, active boolean, push_ok boolean, has_device boolean, email_ok boolean, email text, sms_ok boolean, phone text, quiet boolean)
language sql stable security definer set search_path to ''
as $function$ select * from private.channel_access(p_users); $function$;

-- --- the delivery log -----------------------------------------------------------------
create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('push', 'email', 'sms')),
  attempt integer not null default 1 check (attempt between 1 and 5),
  status text not null check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  -- Why it was skipped or failed, in a word: no_device, push_disabled, seen_meanwhile, inactive,
  -- email_off, sms_not_allowed, phone_changed, quiet_mode, expired, interrupted, provider_not_set_up, ...
  reason text,
  destination text,
  provider text,
  provider_message_id text,
  error text,
  -- False for a failure that trying again cannot fix (a bounced address, a number that cannot receive texts).
  retryable boolean not null default true,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_once unique (notification_id, channel, attempt)
);
create index notification_deliveries_queue_idx on public.notification_deliveries (queued_at) where status in ('queued', 'sending');
create index notification_deliveries_user_idx on public.notification_deliveries (user_id);
create index notification_deliveries_notification_idx on public.notification_deliveries (notification_id);

alter table public.notification_deliveries enable row level security;
create policy notification_deliveries_admin_read on public.notification_deliveries
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.notification_deliveries as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.notification_deliveries from public, anon, authenticated;
grant select on public.notification_deliveries to authenticated;
grant select, insert, update on public.notification_deliveries to service_role;

-- --- the ladder -------------------------------------------------------------------------
-- What is due right now: important notifications nobody has seen, past the wait.
--   * Someone push can reach waits fallback_hours (from when the notification was made).
--   * Someone push cannot reach (no device, push switched off) or whose push failed does not wait.
--   * Email goes to kinds in email_fallback_kinds; text to kinds in important_kinds, to people
--     with a recorded agreement, once the master switch is on.
--   * "Quiet" people are left alone except for urgent alerts; a muted conversation stays muted.
--   * A channel is queued once per notification: if any email row exists, no second one is made here.
create or replace function private.ladder_due(p_now timestamptz default now())
returns table (notification_id uuid, user_id uuid, channel text, destination text)
language sql stable security definer set search_path to ''
as $function$
  with s as (select * from public.notification_settings where id = 'ladder'),
  cand as (
    select n.id as nid, n.recipient_user_id as uid, n.kind, n.created_at, n.subject_type, n.subject_id
    from public.notifications n cross join s
    where n.read_at is null and n.push_opened_at is null
      and n.created_at <= p_now and n.created_at > p_now - interval '14 days'
      and (n.kind = any (s.email_fallback_kinds) or n.kind = any (s.important_kinds))
  ),
  calc as (
    select c.nid, c.uid,
      ca.email_ok, ca.email, ca.sms_ok, ca.phone,
      (c.kind = any (s.email_fallback_kinds) and s.email_fallback_enabled) as email_kind,
      (c.kind = any (s.important_kinds) and s.sms_enabled) as sms_kind,
      case when ca.push_ok and coalesce(pd.status, '') <> 'failed'
           then c.created_at + make_interval(hours => s.fallback_hours)
           else c.created_at end as due_at,
      s.sms_extra_hours
    from cand c
    cross join s
    join private.channel_access((select array_agg(distinct cand.uid) from cand)) ca on ca.user_id = c.uid
    left join public.notification_deliveries pd on pd.notification_id = c.nid and pd.channel = 'push' and pd.attempt = 1
    where ca.active
      and (not ca.quiet or c.kind = 'broadcast_urgent')
      and not exists (
        select 1 from public.conversation_members m
        where c.subject_type = 'conversation' and m.conversation_id = c.subject_id and m.user_id = c.uid and m.muted)
  )
  select calc.nid, calc.uid, 'email'::text, calc.email from calc
  where calc.email_kind and calc.email_ok and calc.due_at <= p_now
    and not exists (select 1 from public.notification_deliveries d where d.notification_id = calc.nid and d.channel = 'email')
  union all
  select calc.nid, calc.uid, 'sms'::text, calc.phone from calc
  where calc.sms_kind and calc.sms_ok and calc.due_at + make_interval(hours => calc.sms_extra_hours) <= p_now
    and not exists (select 1 from public.notification_deliveries d where d.notification_id = calc.nid and d.channel = 'sms');
$function$;

-- The scheduled job. Returns what it did, for the logs and the tests.
create or replace function private.run_notification_ladder(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare v_interrupted integer; v_queued integer; v_retried integer;
begin
  -- A send that never reported back (the function died mid-run) is closed as failed. It may be
  -- retried below, which is the only way a message could ever go twice, and a late duplicate is
  -- the lesser evil next to a person who never heard about a closure.
  update public.notification_deliveries
  set status = 'failed', reason = 'interrupted', error = 'The sender stopped before reporting back.', updated_at = p_now
  where status = 'sending' and updated_at < p_now - interval '15 minutes';
  get diagnostics v_interrupted = row_count;

  with added as (
    insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, destination, queued_at, updated_at)
    select due.notification_id, due.user_id, due.channel, 1, 'queued', due.destination, p_now, p_now
    from private.ladder_due(p_now) due
    on conflict (notification_id, channel, attempt) do nothing
    returning 1)
  select count(*) into v_queued from added;

  -- A failed email or text gets up to three tries, fifteen minutes apart, while still unseen.
  with added as (
    insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, destination, queued_at, updated_at)
    select d.notification_id, d.user_id, d.channel, d.attempt + 1, 'queued', d.destination, p_now, p_now
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    where d.channel in ('email', 'sms') and d.status = 'failed' and d.retryable and d.attempt < 3
      and d.updated_at <= p_now - interval '15 minutes'
      and n.read_at is null and n.push_opened_at is null
      and not exists (select 1 from public.notification_deliveries x
                      where x.notification_id = d.notification_id and x.channel = d.channel and x.attempt > d.attempt)
    on conflict (notification_id, channel, attempt) do nothing
    returning 1)
  select count(*) into v_retried from added;

  return jsonb_build_object('queued', v_queued, 'retried', v_retried, 'interrupted', v_interrupted);
end;
$function$;

revoke all on function private.ladder_due(timestamptz) from public, anon, authenticated;
revoke all on function private.run_notification_ladder(timestamptz) from public, anon, authenticated;

-- --- sending: take queued rows, re-check every rule, report back -----------------------
-- Called by the deliver-notifications edge function (service role). Every rule is checked
-- again here, at the moment of sending: the person may have read it, switched the channel
-- off, withdrawn their agreement, changed their number or been deactivated since it was queued.
-- Rows that fail a check are closed as skipped, with the reason, and are not returned.
create or replace function public.claim_deliveries(p_channels text[] default array['email', 'sms'], p_limit integer default 100)
returns table (delivery_id uuid, notification_id uuid, user_id uuid, channel text, attempt integer, destination text,
               kind text, title text, body text, link_path text, urgent boolean)
language plpgsql security definer set search_path to ''
as $function$
#variable_conflict use_column
begin
  -- Anything that waited more than a day is no longer news; do not send it late.
  update public.notification_deliveries d
  set status = 'skipped', reason = 'expired', updated_at = now()
  where d.status = 'queued' and d.channel = any (p_channels) and d.queued_at < now() - interval '24 hours';

  return query
  with q as (
    select d.id as did, d.channel as ch, d.destination as dest, n.kind as k, n.read_at as read_at, n.push_opened_at as opened_at,
           ca.active, ca.email_ok, ca.email as cur_email, ca.sms_ok, ca.phone as cur_phone, ca.quiet
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    left join private.channel_access((select array_agg(distinct x.user_id) from public.notification_deliveries x where x.status = 'queued')) ca
      on ca.user_id = d.user_id
    where d.status = 'queued' and d.channel = any (p_channels)
    order by d.queued_at
    limit p_limit
    for update of d skip locked
  ),
  decided as (
    select q.did,
      case
        when q.read_at is not null or q.opened_at is not null then 'seen_meanwhile'
        when not coalesce(q.active, false) then 'inactive'
        when q.quiet and q.k <> 'broadcast_urgent' then 'quiet_mode'
        when q.ch = 'email' and not coalesce(q.email_ok, false) then 'email_off'
        when q.ch = 'sms' and not coalesce(q.sms_ok, false) then 'sms_not_allowed'
        when q.ch = 'sms' and q.dest is distinct from q.cur_phone then 'phone_changed'
      end as skip_reason,
      case when q.ch = 'email' then q.cur_email else q.dest end as dest_now
    from q
  ),
  upd as (
    update public.notification_deliveries d
    set status = case when dc.skip_reason is null then 'sending' else 'skipped' end,
        reason = dc.skip_reason, destination = dc.dest_now, updated_at = now()
    from decided dc
    where d.id = dc.did
    returning d.id, d.notification_id, d.user_id, d.channel, d.attempt, d.destination, d.status
  )
  select u.id, u.notification_id, u.user_id, u.channel, u.attempt, u.destination,
         n.kind, n.title, n.body, n.link_path, (n.kind = 'broadcast_urgent')
  from upd u join public.notifications n on n.id = u.notification_id
  where u.status = 'sending';
end;
$function$;

create or replace function public.finish_delivery(
  p_id uuid, p_status text, p_reason text default null, p_provider text default null,
  p_message_id text default null, p_error text default null, p_retryable boolean default true)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if p_status not in ('sent', 'failed', 'skipped') then raise exception 'Unknown status.'; end if;
  update public.notification_deliveries
  set status = p_status, reason = p_reason, provider = p_provider, provider_message_id = p_message_id,
      error = left(p_error, 500), retryable = coalesce(p_retryable, true),
      sent_at = case when p_status = 'sent' then now() end, updated_at = now()
  where id = p_id and status = 'sending';
end;
$function$;

-- --- what the administrator sees ------------------------------------------------------------
create or replace function public.admin_delivery_summary(p_days integer default 7)
returns table (channel text, status text, total bigint)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_notification_admin();
  return query
  select d.channel, d.status, count(*)
  from public.notification_deliveries d
  where d.queued_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
  group by d.channel, d.status
  order by d.channel, d.status;
end;
$function$;

-- --- permissions ------------------------------------------------------------------------------
revoke all on function public.record_notification_open(uuid) from public, anon;
revoke all on function public.admin_update_notification_settings(integer, integer, text[], text[], boolean, boolean) from public, anon;
revoke all on function public.my_notification_preferences() from public, anon;
revoke all on function public.set_my_notification_preferences(boolean, boolean, boolean) from public, anon;
revoke all on function public.set_my_sms_consent(text, boolean) from public, anon;
revoke all on function public.sms_consent_wording() from public, anon;
revoke all on function public.admin_delivery_summary(integer) from public, anon;
revoke all on function private.require_notification_admin() from public, anon, authenticated;
revoke all on function private.channel_access(uuid[]) from public, anon, authenticated;
revoke all on function private.normalize_phone(text) from public, anon, authenticated;
grant execute on function public.record_notification_open(uuid) to authenticated;
grant execute on function public.admin_update_notification_settings(integer, integer, text[], text[], boolean, boolean) to authenticated;
grant execute on function public.my_notification_preferences() to authenticated;
grant execute on function public.set_my_notification_preferences(boolean, boolean, boolean) to authenticated;
grant execute on function public.set_my_sms_consent(text, boolean) to authenticated;
grant execute on function public.sms_consent_wording() to authenticated;
grant execute on function public.admin_delivery_summary(integer) to authenticated;

-- Service role only: the edge functions and the texting provider's STOP report.
revoke all on function public.claim_deliveries(text[], integer) from public, anon, authenticated;
revoke all on function public.finish_delivery(uuid, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.channel_access_for(uuid[]) from public, anon, authenticated;
revoke all on function public.record_sms_opt_out(text, text) from public, anon, authenticated;
grant execute on function public.claim_deliveries(text[], integer) to service_role;
grant execute on function public.finish_delivery(uuid, text, text, text, text, text, boolean) to service_role;
grant execute on function public.channel_access_for(uuid[]) to service_role;
grant execute on function public.record_sms_opt_out(text, text) to service_role;

-- --- schedules ---------------------------------------------------------------------------------
-- The ladder runs inside the database every 15 minutes. Queued emails and texts are sent by
-- the deliver-notifications function, called every minute but only when something is queued.
-- Reuses the shared secret deliver-emails and deliver-push already read from Vault.
select cron.unschedule('notification-ladder')
where exists (select 1 from cron.job where jobname = 'notification-ladder');

select cron.schedule('notification-ladder', '*/15 * * * *', $$ select private.run_notification_ladder(); $$);

select cron.unschedule('deliver-notifications')
where exists (select 1 from cron.job where jobname = 'deliver-notifications');

select cron.schedule(
  'deliver-notifications',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/deliver-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-delivery-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_DELIVERY_SECRET')
    ),
    body := jsonb_build_object('mode', 'process')
  )
  where exists (
    select 1 from public.notification_deliveries d
    where d.status = 'queued' and d.channel in ('email', 'sms')
  );
  $$
);
