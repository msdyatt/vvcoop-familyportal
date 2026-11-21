-- Teaching commitment tracker (issue #151; handbook map #128; substitutes #129; hall monitor #136).
--
-- The handbook asks every family for one adult to teach one class and to assist in at least two each co-op day, and a
-- hall monitor checks that children are in class. Admins kept this in a spreadsheet: one row per adult, and for each
-- "Block" (the portal's academic TERM; the portal's class_blocks are the class PERIODS) how many of the periods that
-- adult taught, assisted or served as hall monitor.
--
-- How a cell is worked out, for one adult (or one text-only name), one term and one role:
--   automatic = Taught:   the periods in which they are the lead teacher of a class that runs in that term
--               Assisted: the same for assistant assignments
--               Hall:     the periods they are hall monitor for in that term (public.hall_monitor_assignments)
--               A class runs in the terms it is linked to (public.class_terms); a class with no links runs all year.
--               A class with no period counts on its own. Reviewer (demo) accounts and demo classes never count.
--   value     = (the active "set" entry for the cell, if there is one, otherwise automatic) + every active "adjust"
--               entry for the cell, and never below zero.
-- "Set" entries come from the spreadsheet import (the spreadsheet is the record for the terms chosen at import);
-- "adjust" entries are admins' corrections (a substitution, work outside the portal), each with a reason.
-- Entries are never edited or deleted: an admin removes one, with a reason, and it stays as history. Every change is
-- also written to public.audit_log.
--
-- Hook for #129: the substitute requests should call private.record_commitment_entry(..., p_source => 'substitute',
-- p_source_ref => <request id>), with +1 for the person covering and -1 for the person absent. Those entries show in
-- the tracker as adjustments from a substitution.
--
-- Everything here is admin-only: RLS lets only an administrator who is not a reviewer and has used their second factor
-- read the tables, and every write goes through the SECURITY DEFINER functions below, which check the same.

-- --- who may use it --------------------------------------------------------------------------------------------------
create or replace function private.is_commitment_admin()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select (select auth.uid()) is not null and private.has_role('admin') and not private.is_demo_user()
    and private.aal_satisfied();
$function$;
revoke all on function private.is_commitment_admin() from public, anon;
grant execute on function private.is_commitment_admin() to authenticated;

create or replace function private.require_commitment_admin()
returns uuid
language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') or private.is_demo_user() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;
revoke all on function private.require_commitment_admin() from public, anon;
grant execute on function private.require_commitment_admin() to authenticated;

-- --- settings ----------------------------------------------------------------------------------------------------------
-- The handbook's expectation, per household and per co-op day (every co-op day in a term has the same periods, so a
-- term's counts are one co-op day's). Admin settings with the handbook's numbers as defaults.
create table public.teaching_commitment_settings (
  id text primary key default 'coop' check (id = 'coop'),
  teach_target smallint not null default 1 check (teach_target between 0 and 8),
  assist_target smallint not null default 2 check (assist_target between 0 and 8),
  -- Whether a period as hall monitor counts towards the household's assisting.
  hall_counts_as_assist boolean not null default true,
  -- An adult with this many roles or more in one term is marked as carrying a lot.
  heavy_load smallint not null default 4 check (heavy_load between 1 and 12),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.teaching_commitment_settings (id) values ('coop') on conflict do nothing;

-- --- hall monitors -----------------------------------------------------------------------------------------------------
-- Who is hall monitor in which period (class_blocks) of which term. Admin-managed.
create table public.hall_monitor_assignments (
  term_id uuid not null references public.academic_terms(id) on delete cascade,
  block_id uuid not null references public.class_blocks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  primary key (term_id, block_id, user_id)
);
create index hall_monitor_assignments_user_idx on public.hall_monitor_assignments(user_id);

-- --- entries (manual adjustments, imported counts, later substitutions) ------------------------------------------------
create table public.teaching_commitment_entries (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references public.school_years(id) on delete cascade,
  term_id uuid not null references public.academic_terms(id) on delete cascade,
  -- A portal account, or a name kept as text when the spreadsheet named someone with no account.
  user_id uuid references public.profiles(id) on delete cascade,
  person_label text check (person_label is null or char_length(btrim(person_label)) between 1 and 120),
  role text not null check (role in ('taught', 'assisted', 'hall_monitor')),
  kind text not null check (kind in ('adjust', 'set')),
  amount smallint not null,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  source text not null default 'manual' check (source in ('manual', 'import', 'substitute')),
  -- What the entry came from, e.g. a substitute request (#129).
  source_ref text check (source_ref is null or char_length(source_ref) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_reason text check (removed_reason is null or char_length(btrim(removed_reason)) between 3 and 500),
  constraint teaching_commitment_entries_person check ((user_id is null) <> (person_label is null)),
  constraint teaching_commitment_entries_amount check (
    (kind = 'set' and amount between 0 and 12) or (kind = 'adjust' and amount between -12 and 12 and amount <> 0)),
  constraint teaching_commitment_entries_removed check ((removed_at is null) = (removed_reason is null))
);
create index teaching_commitment_entries_year_idx on public.teaching_commitment_entries(school_year_id, term_id);
create index teaching_commitment_entries_user_idx on public.teaching_commitment_entries(user_id);
-- At most one active "set" per cell.
create unique index teaching_commitment_entries_one_set on public.teaching_commitment_entries
  (term_id, coalesce(user_id::text, 'label:' || lower(btrim(person_label))), role)
  where kind = 'set' and removed_at is null;

-- Entries are history: nothing changes once written, except that an active entry may be marked removed.
create or replace function private.teaching_commitment_entries_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if old.removed_at is not null
     or new.removed_at is null
     or (new.id, new.school_year_id, new.term_id, new.user_id, new.person_label, new.role, new.kind, new.amount,
         new.reason, new.source, new.source_ref, new.created_at, new.created_by)
        is distinct from
        (old.id, old.school_year_id, old.term_id, old.user_id, old.person_label, old.role, old.kind, old.amount,
         old.reason, old.source, old.source_ref, old.created_at, old.created_by) then
    raise exception 'Teaching commitment entries cannot be changed; remove the entry and add a new one.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
create trigger teaching_commitment_entries_guard before update on public.teaching_commitment_entries
  for each row execute function private.teaching_commitment_entries_guard();

-- --- notes ("Notes / classes covered", the admins' own words) ---------------------------------------------------------
create table public.teaching_commitment_notes (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references public.school_years(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  person_label text check (person_label is null or char_length(btrim(person_label)) between 1 and 120),
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint teaching_commitment_notes_person check ((user_id is null) <> (person_label is null))
);
create unique index teaching_commitment_notes_user on public.teaching_commitment_notes(school_year_id, user_id)
  where user_id is not null;
create unique index teaching_commitment_notes_label on public.teaching_commitment_notes(school_year_id, lower(btrim(person_label)))
  where person_label is not null;

-- --- access ------------------------------------------------------------------------------------------------------------
alter table public.teaching_commitment_settings enable row level security;
alter table public.hall_monitor_assignments enable row level security;
alter table public.teaching_commitment_entries enable row level security;
alter table public.teaching_commitment_notes enable row level security;

create policy teaching_commitment_settings_admin_read on public.teaching_commitment_settings
  for select to authenticated using (private.is_commitment_admin());
create policy hall_monitor_assignments_admin_read on public.hall_monitor_assignments
  for select to authenticated using (private.is_commitment_admin());
create policy teaching_commitment_entries_admin_read on public.teaching_commitment_entries
  for select to authenticated using (private.is_commitment_admin());
create policy teaching_commitment_notes_admin_read on public.teaching_commitment_notes
  for select to authenticated using (private.is_commitment_admin());

revoke all on public.teaching_commitment_settings, public.hall_monitor_assignments,
  public.teaching_commitment_entries, public.teaching_commitment_notes from public, anon, authenticated;
grant select on public.teaching_commitment_settings, public.hall_monitor_assignments,
  public.teaching_commitment_entries, public.teaching_commitment_notes to authenticated;
grant all on public.teaching_commitment_settings, public.hall_monitor_assignments,
  public.teaching_commitment_entries, public.teaching_commitment_notes to service_role;

-- --- small helpers -----------------------------------------------------------------------------------------------------
create or replace function private.commitment_role_label(p_role text)
returns text
language sql immutable set search_path to ''
as $function$
  select case p_role when 'taught' then 'Taught' when 'assisted' then 'Assisted' when 'hall_monitor' then 'Hall monitor'
    else p_role end;
$function$;
revoke all on function private.commitment_role_label(text) from public, anon;

-- An account that can be counted: exists, has not been removed, and is not a reviewer.
create or replace function private.commitment_person_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.profiles p where p.id = p_user and p.status <> 'removed' and not p.is_demo);
$function$;
revoke all on function private.commitment_person_ok(uuid) from public, anon, authenticated;

-- The one place an entry is written. The admin functions and the import call it; #129's substitute requests should too.
create or replace function private.record_commitment_entry(
  p_actor uuid, p_term_id uuid, p_user_id uuid, p_person_label text, p_role text, p_kind text, p_amount integer,
  p_reason text, p_source text default 'manual', p_source_ref text default null, p_audit boolean default true)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_year uuid;
  v_label text := nullif(btrim(coalesce(p_person_label, '')), '');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
  v_replaced uuid;
begin
  select t.school_year_id into v_year from public.academic_terms t where t.id = p_term_id;
  if v_year is null then
    raise exception 'Choose a term.' using errcode = 'P0001';
  end if;
  if p_user_id is not null then
    if not private.commitment_person_ok(p_user_id) then
      raise exception 'That person cannot be counted.' using errcode = 'P0001';
    end if;
    v_label := null;
  elsif v_label is null then
    raise exception 'Choose a person, or give the name to keep.' using errcode = 'P0001';
  elsif char_length(v_label) > 120 then
    raise exception 'Keep the name to 120 characters.' using errcode = 'P0001';
  else
    -- Reuse the spelling already on file for this name, so one person stays one row.
    select coalesce((select e.person_label from public.teaching_commitment_entries e
                     where e.school_year_id = v_year and lower(btrim(e.person_label)) = lower(v_label)
                     order by e.created_at limit 1), v_label) into v_label;
  end if;
  if coalesce(p_role, '') not in ('taught', 'assisted', 'hall_monitor') then
    raise exception 'Choose Taught, Assisted or Hall monitor.' using errcode = 'P0001';
  end if;
  if coalesce(p_kind, '') not in ('adjust', 'set') then
    raise exception 'Choose whether to adjust the count or set it.' using errcode = 'P0001';
  end if;
  if p_amount is null or (p_kind = 'set' and p_amount not between 0 and 12)
     or (p_kind = 'adjust' and (p_amount = 0 or p_amount not between -12 and 12)) then
    raise exception 'An adjustment is a whole number from -12 to 12 (not zero); a count is 0 to 12.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Give a reason for the change.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'Keep the reason to 500 characters.' using errcode = 'P0001';
  end if;
  if coalesce(p_source, '') not in ('manual', 'import', 'substitute') then
    raise exception 'Unknown source for a teaching commitment entry.' using errcode = 'P0001';
  end if;

  if p_kind = 'set' then
    update public.teaching_commitment_entries e
       set removed_at = now(), removed_by = p_actor, removed_reason = 'Replaced by a newer count.'
     where e.term_id = p_term_id and e.role = p_role and e.kind = 'set' and e.removed_at is null
       and (case when p_user_id is not null then e.user_id = p_user_id
                 else e.user_id is null and lower(btrim(e.person_label)) = lower(v_label) end)
    returning e.id into v_replaced;
  end if;

  insert into public.teaching_commitment_entries
    (school_year_id, term_id, user_id, person_label, role, kind, amount, reason, source, source_ref, created_by)
  values (v_year, p_term_id, p_user_id, v_label, p_role, p_kind, p_amount, v_reason, p_source,
          nullif(btrim(coalesce(p_source_ref, '')), ''), p_actor)
  returning id into v_id;

  if p_audit and p_actor is not null then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (p_actor, 'teaching_commitment_adjusted', 'teaching_commitment_entry', v_id::text,
      jsonb_strip_nulls(jsonb_build_object('term_id', p_term_id, 'user_id', p_user_id, 'person_label', v_label,
        'role', p_role, 'kind', p_kind, 'amount', p_amount, 'reason', v_reason, 'source', p_source,
        'replaced', v_replaced)));
  end if;
  return v_id;
end;
$function$;
revoke all on function private.record_commitment_entry(uuid, uuid, uuid, text, text, text, integer, text, text, text, boolean)
  from public, anon, authenticated;

-- --- the counts ----------------------------------------------------------------------------------------------------------
-- One row per person (account or text-only name), term and role that has anything: the automatic count, the active
-- "set" value, the sum of active adjustments and the resulting value. Used by admin_teaching_commitment.
create or replace function private.commitment_cells(p_school_year_id uuid)
returns table (person_key text, user_id uuid, person_label text, term_id uuid, role text,
               auto_count integer, set_value integer, adjust_sum integer, value integer)
language sql stable security definer set search_path to ''
as $function$
  with terms as (
    select t.id from public.academic_terms t where t.school_year_id = p_school_year_id
  ), class_in_term as (
    select c.id as class_id, c.block_id, t.id as term_id
    from public.classes c
    join terms t on exists (select 1 from public.class_terms ct where ct.class_id = c.id and ct.term_id = t.id)
                 or not exists (select 1 from public.class_terms ct where ct.class_id = c.id)
    where c.school_year_id = p_school_year_id and not c.is_demo
  ), auto as (
    select ta.user_id, cit.term_id,
           case ta.assignment_role when 'lead' then 'taught' else 'assisted' end as role,
           count(distinct coalesce(cit.block_id::text, 'class:' || cit.class_id::text))::integer as n
    from class_in_term cit
    join public.teacher_assignments ta on ta.class_id = cit.class_id
    join public.profiles p on p.id = ta.user_id and not p.is_demo
    group by 1, 2, 3
    union all
    select h.user_id, h.term_id, 'hall_monitor', count(distinct h.block_id)::integer
    from public.hall_monitor_assignments h
    join terms t on t.id = h.term_id
    join public.profiles p on p.id = h.user_id and not p.is_demo
    group by 1, 2
  ), ent as (
    select coalesce(e.user_id::text, 'label:' || lower(btrim(e.person_label))) as person_key,
           e.user_id, max(e.person_label) as person_label, e.term_id, e.role,
           max(e.amount) filter (where e.kind = 'set')::integer as set_value,
           coalesce(sum(e.amount) filter (where e.kind = 'adjust'), 0)::integer as adjust_sum
    from public.teaching_commitment_entries e
    left join public.profiles p on p.id = e.user_id
    where e.school_year_id = p_school_year_id and e.removed_at is null and (e.user_id is null or not p.is_demo)
    group by 1, 2, 4, 5
  )
  select coalesce(ent.person_key, auto.user_id::text), coalesce(ent.user_id, auto.user_id), ent.person_label,
         coalesce(ent.term_id, auto.term_id), coalesce(ent.role, auto.role),
         coalesce(auto.n, 0), ent.set_value, coalesce(ent.adjust_sum, 0),
         greatest(0, coalesce(ent.set_value, auto.n, 0) + coalesce(ent.adjust_sum, 0))
  from auto
  full join ent on ent.user_id = auto.user_id and ent.term_id = auto.term_id and ent.role = auto.role;
$function$;
revoke all on function private.commitment_cells(uuid) from public, anon, authenticated;

-- --- what the screen reads ---------------------------------------------------------------------------------------------
-- Everything the tracker shows for one school year (the current one when p_school_year_id is null), as one document.
create or replace function public.admin_teaching_commitment(p_school_year_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_year public.school_years%rowtype;
  v_settings public.teaching_commitment_settings%rowtype;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_result jsonb;
begin
  if p_school_year_id is null then
    select * into v_year from public.school_years where is_current order by starts_on desc nulls last limit 1;
  else
    select * into v_year from public.school_years where id = p_school_year_id;
  end if;
  select * into v_settings from public.teaching_commitment_settings where id = 'coop';

  if v_year.id is null then
    return jsonb_build_object(
      'school_year', null,
      'years', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'label', y.label, 'is_current', y.is_current)
                                          order by y.starts_on desc nulls last, y.label desc)
                         from public.school_years y), '[]'::jsonb),
      'settings', to_jsonb(v_settings) - 'id');
  end if;

  with cells as (
    select * from private.commitment_cells(v_year.id)
  ), terms as (
    select t.id, t.label, t.starts_on, t.ends_on, t.sort_order,
           -- A term is checked against the handbook once it has started, or once anyone has a role in it.
           (t.starts_on <= v_today or exists (select 1 from cells c where c.term_id = t.id and c.value > 0)) as checked
    from public.academic_terms t where t.school_year_id = v_year.id
  ), leaving as (
    select hsy.family_id from public.household_school_years hsy
    where hsy.school_year_id = v_year.id and hsy.status = 'not_returning'
  ), households as (
    select f.id, coalesce(nullif(btrim(f.last_name), ''), f.display_name) as name
    from public.families f
    where f.id not in (select family_id from leaving)
      and not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id
                      where fm.family_id = f.id and p.is_demo)
  ), home as (
    -- Each account's household (the first by name, in the rare case of two).
    select distinct on (fm.user_id) fm.user_id, h.id as household_id, h.name as household_name
    from public.family_members fm join households h on h.id = fm.family_id
    order by fm.user_id, h.name, h.id
  ), people_raw as (
    -- Active adults of the year's households, and anyone (or any kept name) with a count or a note.
    select p.id::text as person_key, p.id as user_id, null::text as person_label
    from public.profiles p join home on home.user_id = p.id
    where p.status = 'active' and not p.is_demo
    union
    select distinct c.person_key, c.user_id, case when c.user_id is null then c.person_label end
    from cells c where c.value > 0 or c.set_value is not null or c.adjust_sum <> 0
    union
    select coalesce(n.user_id::text, 'label:' || lower(btrim(n.person_label))), n.user_id,
           case when n.user_id is null then n.person_label end
    from public.teaching_commitment_notes n
    left join public.profiles p on p.id = n.user_id
    where n.school_year_id = v_year.id and (n.user_id is null or not p.is_demo)
  ), people as (
    select distinct on (pr.person_key) pr.person_key, pr.user_id, pr.person_label
    from people_raw pr order by pr.person_key, pr.person_label nulls last
  ), person_rows as (
    select pe.person_key, pe.user_id, pe.person_label,
           coalesce(nullif(btrim(pr.display_name), ''), pr.email, pe.person_label) as name,
           home.household_id, home.household_name,
           coalesce(sum(c.value) filter (where c.role = 'taught'), 0)::integer as taught,
           coalesce(sum(c.value) filter (where c.role = 'assisted'), 0)::integer as assisted,
           coalesce(sum(c.value) filter (where c.role = 'hall_monitor'), 0)::integer as hall_monitor,
           coalesce(sum(c.value), 0)::integer as total_roles,
           (select count(*) from (select c2.term_id from cells c2 where c2.person_key = pe.person_key
                                  group by c2.term_id having sum(c2.value) > 0) x)::integer as blocks_participated,
           coalesce((select max(s) from (select sum(c3.value) as s from cells c3 where c3.person_key = pe.person_key
                                         group by c3.term_id) y), 0)::integer as max_term_roles
    from people pe
    left join public.profiles pr on pr.id = pe.user_id
    left join home on home.user_id = pe.user_id
    left join cells c on c.person_key = pe.person_key
    group by pe.person_key, pe.user_id, pe.person_label, pr.display_name, pr.email, home.household_id, home.household_name
  ), household_terms as (
    select h.id as household_id, t.id as term_id, t.checked,
           coalesce(sum(c.value) filter (where c.role = 'taught'), 0)::integer as taught,
           coalesce(sum(c.value) filter (where c.role = 'assisted'), 0)::integer as assisted,
           coalesce(sum(c.value) filter (where c.role = 'hall_monitor'), 0)::integer as hall_monitor
    from households h
    cross join terms t
    left join home on home.household_id = h.id
    left join cells c on c.user_id = home.user_id and c.term_id = t.id
    group by h.id, t.id, t.checked
  ), household_check as (
    select ht.*,
           (ht.taught >= v_settings.teach_target
            and ht.assisted + case when v_settings.hall_counts_as_assist then ht.hall_monitor else 0 end
                >= v_settings.assist_target) as meets
    from household_terms ht
  )
  select jsonb_build_object(
    'school_year', jsonb_build_object('id', v_year.id, 'label', v_year.label, 'is_current', v_year.is_current),
    'years', coalesce((select jsonb_agg(jsonb_build_object('id', y.id, 'label', y.label, 'is_current', y.is_current)
                                        order by y.starts_on desc nulls last, y.label desc)
                       from public.school_years y), '[]'::jsonb),
    'settings', to_jsonb(v_settings) - 'id',
    'today', v_today,
    'terms', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'starts_on', t.starts_on,
                                          'ends_on', t.ends_on, 'checked', t.checked)
                                        order by t.sort_order, t.starts_on) from terms t), '[]'::jsonb),
    'periods', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'starts_at', b.starts_at,
                                            'ends_at', b.ends_at) order by b.sort_order, b.starts_at)
                         from public.class_blocks b where b.school_year_id = v_year.id or b.school_year_id is null), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'key', pr.person_key, 'user_id', pr.user_id, 'label', pr.person_label, 'name', pr.name,
        'household_id', pr.household_id, 'household_name', pr.household_name,
        'taught', pr.taught, 'assisted', pr.assisted, 'hall_monitor', pr.hall_monitor,
        'total_roles', pr.total_roles, 'blocks_participated', pr.blocks_participated,
        'max_term_roles', pr.max_term_roles, 'heavy', pr.max_term_roles >= v_settings.heavy_load,
        'note', (select n.note from public.teaching_commitment_notes n where n.school_year_id = v_year.id
                 and coalesce(n.user_id::text, 'label:' || lower(btrim(n.person_label))) = pr.person_key),
        'cells', coalesce((select jsonb_agg(jsonb_build_object('term_id', c.term_id, 'role', c.role, 'auto', c.auto_count,
                                              'set', c.set_value, 'adjust', c.adjust_sum, 'value', c.value))
                           from cells c where c.person_key = pr.person_key), '[]'::jsonb),
        'classes', coalesce((select jsonb_agg(jsonb_build_object('term_id', t.id, 'title', cl.title,
                                                'role', case ta.assignment_role when 'lead' then 'taught' else 'assisted' end)
                                              order by t.sort_order, cl.title)
                             from public.teacher_assignments ta
                             join public.classes cl on cl.id = ta.class_id and cl.school_year_id = v_year.id and not cl.is_demo
                             join terms t on exists (select 1 from public.class_terms ct where ct.class_id = cl.id and ct.term_id = t.id)
                                          or not exists (select 1 from public.class_terms ct where ct.class_id = cl.id)
                             where ta.user_id = pr.user_id), '[]'::jsonb),
        'hall', coalesce((select jsonb_agg(jsonb_build_object('term_id', h.term_id, 'block_id', h.block_id))
                          from public.hall_monitor_assignments h join terms t on t.id = h.term_id
                          where h.user_id = pr.user_id), '[]'::jsonb)
      ) order by pr.total_roles desc, pr.name) from person_rows pr), '[]'::jsonb),
    'households', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'name', h.name,
        'terms', (select jsonb_agg(jsonb_build_object('term_id', hc.term_id, 'taught', hc.taught, 'assisted', hc.assisted,
                                     'hall_monitor', hc.hall_monitor, 'checked', hc.checked, 'meets', hc.meets))
                  from household_check hc where hc.household_id = h.id),
        'taught', (select coalesce(sum(hc.taught), 0) from household_check hc where hc.household_id = h.id),
        'assisted', (select coalesce(sum(hc.assisted), 0) from household_check hc where hc.household_id = h.id),
        'hall_monitor', (select coalesce(sum(hc.hall_monitor), 0) from household_check hc where hc.household_id = h.id),
        'total_roles', (select coalesce(sum(hc.taught + hc.assisted + hc.hall_monitor), 0) from household_check hc
                        where hc.household_id = h.id),
        'short_terms', (select count(*) from household_check hc where hc.household_id = h.id and hc.checked and not hc.meets),
        'meets', not exists (select 1 from household_check hc where hc.household_id = h.id and hc.checked and not hc.meets)
      ) order by h.name) from households h), '[]'::jsonb),
    'hall_monitors', coalesce((select jsonb_agg(jsonb_build_object('term_id', h.term_id, 'block_id', h.block_id,
                                                  'user_id', h.user_id))
                               from public.hall_monitor_assignments h join terms t on t.id = h.term_id), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'person_key', coalesce(e.user_id::text, 'label:' || lower(btrim(e.person_label))),
        'term_id', e.term_id, 'role', e.role, 'kind', e.kind, 'amount', e.amount, 'reason', e.reason,
        'source', e.source, 'source_ref', e.source_ref, 'created_at', e.created_at,
        'created_by_name', coalesce(nullif(btrim(cb.display_name), ''), cb.email),
        'removed_at', e.removed_at, 'removed_reason', e.removed_reason,
        'removed_by_name', coalesce(nullif(btrim(rb.display_name), ''), rb.email)
      ) order by e.created_at desc)
      from public.teaching_commitment_entries e
      left join public.profiles cb on cb.id = e.created_by
      left join public.profiles rb on rb.id = e.removed_by
      left join public.profiles p on p.id = e.user_id
      where e.school_year_id = v_year.id and (e.user_id is null or not p.is_demo)), '[]'::jsonb),
    -- Accounts a spreadsheet name can be matched to, or a hall monitor chosen from.
    'candidates', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.id, 'name', coalesce(nullif(btrim(p.display_name), ''), p.email), 'email', p.email,
        'household_name', home.household_name, 'status', p.status) order by coalesce(nullif(btrim(p.display_name), ''), p.email))
      from public.profiles p left join home on home.user_id = p.id
      where p.status <> 'removed' and not p.is_demo), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.admin_teaching_commitment(uuid) from public, anon;
grant execute on function public.admin_teaching_commitment(uuid) to authenticated;

-- --- writing -------------------------------------------------------------------------------------------------------------
-- An admin's change to one cell: "adjust" adds or takes away (a substitution, work outside the portal); "set" replaces
-- the automatic count. Always with a reason.
create or replace function public.admin_save_commitment_entry(
  p_term_id uuid, p_user_id uuid, p_person_label text, p_role text, p_kind text, p_amount integer, p_reason text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  return private.record_commitment_entry(v_actor, p_term_id, p_user_id, p_person_label, p_role, p_kind, p_amount,
                                         p_reason, 'manual', null, true);
end;
$function$;
revoke all on function public.admin_save_commitment_entry(uuid, uuid, text, text, text, integer, text) from public, anon;
grant execute on function public.admin_save_commitment_entry(uuid, uuid, text, text, text, integer, text) to authenticated;

create or replace function public.admin_remove_commitment_entry(p_entry_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_entry public.teaching_commitment_entries%rowtype;
begin
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for removing the entry.' using errcode = 'P0001';
  end if;
  select * into v_entry from public.teaching_commitment_entries where id = p_entry_id;
  if v_entry.id is null then
    raise exception 'That entry was not found.' using errcode = 'P0001';
  end if;
  if v_entry.removed_at is not null then
    raise exception 'That entry was already removed.' using errcode = 'P0001';
  end if;
  update public.teaching_commitment_entries
     set removed_at = now(), removed_by = v_actor, removed_reason = v_reason
   where id = p_entry_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_entry_removed', 'teaching_commitment_entry', p_entry_id::text,
    jsonb_strip_nulls(jsonb_build_object('term_id', v_entry.term_id, 'user_id', v_entry.user_id,
      'person_label', v_entry.person_label, 'role', v_entry.role, 'kind', v_entry.kind, 'amount', v_entry.amount,
      'reason', v_reason)));
end;
$function$;
revoke all on function public.admin_remove_commitment_entry(uuid, text) from public, anon;
grant execute on function public.admin_remove_commitment_entry(uuid, text) to authenticated;

-- The note beside a person for the year. An empty note clears it.
create or replace function private.save_commitment_note(
  p_actor uuid, p_school_year_id uuid, p_user_id uuid, p_person_label text, p_note text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_label text := nullif(btrim(coalesce(p_person_label, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not exists (select 1 from public.school_years where id = p_school_year_id) then
    raise exception 'Choose a school year.' using errcode = 'P0001';
  end if;
  if p_user_id is not null then
    if not private.commitment_person_ok(p_user_id) then
      raise exception 'That person cannot be counted.' using errcode = 'P0001';
    end if;
    v_label := null;
  elsif v_label is null or char_length(v_label) > 120 then
    raise exception 'Choose a person, or give the name to keep (up to 120 characters).' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 2000 then
    raise exception 'Keep the note to 2,000 characters.' using errcode = 'P0001';
  end if;

  delete from public.teaching_commitment_notes n
   where n.school_year_id = p_school_year_id
     and (case when p_user_id is not null then n.user_id = p_user_id
               else n.user_id is null and lower(btrim(n.person_label)) = lower(v_label) end);
  if v_note is not null then
    insert into public.teaching_commitment_notes (school_year_id, user_id, person_label, note, updated_by)
    values (p_school_year_id, p_user_id, v_label, v_note, p_actor);
  end if;
end;
$function$;
revoke all on function private.save_commitment_note(uuid, uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.admin_save_commitment_note(
  p_school_year_id uuid, p_user_id uuid, p_person_label text, p_note text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  perform private.save_commitment_note(v_actor, p_school_year_id, p_user_id, p_person_label, p_note);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_note_saved', 'school_year', p_school_year_id::text,
    jsonb_strip_nulls(jsonb_build_object('user_id', p_user_id,
      'person_label', case when p_user_id is null then btrim(p_person_label) end,
      'cleared', nullif(btrim(coalesce(p_note, '')), '') is null)));
end;
$function$;
revoke all on function public.admin_save_commitment_note(uuid, uuid, text, text) from public, anon;
grant execute on function public.admin_save_commitment_note(uuid, uuid, text, text) to authenticated;

create or replace function public.admin_save_commitment_settings(
  p_teach_target integer, p_assist_target integer, p_hall_counts_as_assist boolean, p_heavy_load integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  if p_teach_target is null or p_teach_target not between 0 and 8
     or p_assist_target is null or p_assist_target not between 0 and 8 then
    raise exception 'Targets are whole numbers from 0 to 8.' using errcode = 'P0001';
  end if;
  if p_heavy_load is null or p_heavy_load not between 1 and 12 then
    raise exception 'The "carrying a lot" mark is a whole number from 1 to 12.' using errcode = 'P0001';
  end if;
  update public.teaching_commitment_settings
     set teach_target = p_teach_target, assist_target = p_assist_target,
         hall_counts_as_assist = coalesce(p_hall_counts_as_assist, true), heavy_load = p_heavy_load,
         updated_at = now(), updated_by = v_actor
   where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_settings_saved', 'teaching_commitment_settings', 'coop',
    jsonb_build_object('teach_target', p_teach_target, 'assist_target', p_assist_target,
      'hall_counts_as_assist', coalesce(p_hall_counts_as_assist, true), 'heavy_load', p_heavy_load));
end;
$function$;
revoke all on function public.admin_save_commitment_settings(integer, integer, boolean, integer) from public, anon;
grant execute on function public.admin_save_commitment_settings(integer, integer, boolean, integer) to authenticated;

-- Make someone hall monitor for a period in a term (p_on true), or take them off (false).
create or replace function public.admin_set_hall_monitor(p_term_id uuid, p_block_id uuid, p_user_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_term_year uuid;
  v_block_year uuid;
  v_block_found boolean;
  v_changed integer;
begin
  select school_year_id into v_term_year from public.academic_terms where id = p_term_id;
  if v_term_year is null then
    raise exception 'Choose a term.' using errcode = 'P0001';
  end if;
  select true, school_year_id into v_block_found, v_block_year from public.class_blocks where id = p_block_id;
  if v_block_found is null or (v_block_year is not null and v_block_year <> v_term_year) then
    raise exception 'Choose a period from the same school year.' using errcode = 'P0001';
  end if;
  if coalesce(p_on, false) then
    if not exists (select 1 from public.profiles p where p.id = p_user_id and p.status = 'active' and not p.is_demo) then
      raise exception 'Choose an active member as hall monitor.' using errcode = 'P0001';
    end if;
    insert into public.hall_monitor_assignments (term_id, block_id, user_id, created_by)
    values (p_term_id, p_block_id, p_user_id, v_actor) on conflict do nothing;
  else
    delete from public.hall_monitor_assignments where term_id = p_term_id and block_id = p_block_id and user_id = p_user_id;
  end if;
  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_actor, case when coalesce(p_on, false) then 'hall_monitor_assigned' else 'hall_monitor_removed' end,
      'profile', p_user_id::text, jsonb_build_object('term_id', p_term_id, 'block_id', p_block_id));
  end if;
end;
$function$;
revoke all on function public.admin_set_hall_monitor(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.admin_set_hall_monitor(uuid, uuid, uuid, boolean) to authenticated;

-- A name kept as text turns out to be an account: its entries and note move to the account. The old entries are
-- removed (kept as history) and the active ones are written again for the account.
create or replace function public.admin_link_commitment_label(p_school_year_id uuid, p_person_label text, p_user_id uuid)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_label text := lower(btrim(coalesce(p_person_label, '')));
  v_moved integer := 0;
  v_note text;
  r record;
begin
  if v_label = '' then
    raise exception 'Choose the name to link.' using errcode = 'P0001';
  end if;
  if not private.commitment_person_ok(p_user_id) then
    raise exception 'That person cannot be counted.' using errcode = 'P0001';
  end if;
  for r in
    select * from public.teaching_commitment_entries e
    where e.school_year_id = p_school_year_id and e.user_id is null and lower(btrim(e.person_label)) = v_label
      and e.removed_at is null
    order by e.created_at
  loop
    update public.teaching_commitment_entries
       set removed_at = now(), removed_by = v_actor, removed_reason = 'Linked to a portal account.'
     where id = r.id;
    perform private.record_commitment_entry(v_actor, r.term_id, p_user_id, null, r.role, r.kind, r.amount, r.reason,
                                            r.source, r.source_ref, false);
    v_moved := v_moved + 1;
  end loop;
  select n.note into v_note from public.teaching_commitment_notes n
   where n.school_year_id = p_school_year_id and n.user_id is null and lower(btrim(n.person_label)) = v_label;
  if v_note is not null then
    delete from public.teaching_commitment_notes n
     where n.school_year_id = p_school_year_id and n.user_id is null and lower(btrim(n.person_label)) = v_label;
    if not exists (select 1 from public.teaching_commitment_notes n
                   where n.school_year_id = p_school_year_id and n.user_id = p_user_id) then
      perform private.save_commitment_note(v_actor, p_school_year_id, p_user_id, null, v_note);
    end if;
  end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_label_linked', 'profile', p_user_id::text,
    jsonb_build_object('school_year_id', p_school_year_id, 'person_label', btrim(p_person_label), 'entries', v_moved));
  return v_moved;
end;
$function$;
revoke all on function public.admin_link_commitment_label(uuid, text, uuid) from public, anon;
grant execute on function public.admin_link_commitment_label(uuid, text, uuid) to authenticated;

-- --- import ----------------------------------------------------------------------------------------------------------
-- Saves a spreadsheet the admin has uploaded and checked in the preview (lib/teaching-commitment.ts parses it).
-- p_rows: [{ "user_id": uuid | null, "label": text, "note": text | null,
--            "cells": [{ "term_id": uuid, "taught": n, "assisted": n, "hall_monitor": n }, ...] }, ...]
-- For each row that is kept, each chosen term's three counts are saved as "set" entries (the spreadsheet is the record
-- for those terms), and the note, if any, replaces the person's note. Rows with no person and no name (blank rows) and
-- rows whose counts are all zero are skipped, whatever the browser sent. One line goes to the activity log.
create or replace function public.admin_import_teaching_commitment(
  p_school_year_id uuid, p_term_ids uuid[], p_rows jsonb, p_reason text)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_terms uuid[];
  v_row jsonb;
  v_cell jsonb;
  v_user uuid;
  v_label text;
  v_role text;
  v_value integer;
  v_total integer;
  v_people integer := 0;
  v_entries integer := 0;
  v_blank integer := 0;
  v_zero integer := 0;
  v_unknown integer := 0;
begin
  if not exists (select 1 from public.school_years where id = p_school_year_id) then
    raise exception 'Choose a school year.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(distinct t.id), '{}') into v_terms
  from public.academic_terms t where t.id = any (coalesce(p_term_ids, '{}')) and t.school_year_id = p_school_year_id;
  if cardinality(v_terms) = 0 or cardinality(v_terms) <> (select count(distinct x) from unnest(p_term_ids) x) then
    raise exception 'Choose which terms of this school year the spreadsheet covers.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) < 3 then
    v_reason := 'Imported from the teaching commitment spreadsheet.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to import.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'A spreadsheet can have at most 500 people.' using errcode = 'P0001';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_user := nullif(v_row ->> 'user_id', '')::uuid;
    v_label := nullif(btrim(coalesce(v_row ->> 'label', '')), '');
    if v_user is null and v_label is null then
      v_blank := v_blank + 1;
      continue;
    end if;
    if v_user is not null and not private.commitment_person_ok(v_user) then
      v_unknown := v_unknown + 1;
      continue;
    end if;
    -- Every count the row carries, in any term: a row of zeros means nothing.
    select coalesce(sum(greatest(0, coalesce((c ->> 'taught')::integer, 0)))
                  + sum(greatest(0, coalesce((c ->> 'assisted')::integer, 0)))
                  + sum(greatest(0, coalesce((c ->> 'hall_monitor')::integer, 0))), 0)
      into v_total
    from jsonb_array_elements(coalesce(v_row -> 'cells', '[]'::jsonb)) c;
    if v_total = 0 then
      v_zero := v_zero + 1;
      continue;
    end if;

    for v_cell in select * from jsonb_array_elements(v_row -> 'cells') loop
      if not ((v_cell ->> 'term_id')::uuid = any (v_terms)) then continue; end if;
      foreach v_role in array array['taught', 'assisted', 'hall_monitor'] loop
        v_value := least(12, greatest(0, coalesce((v_cell ->> v_role)::integer, 0)));
        perform private.record_commitment_entry(v_actor, (v_cell ->> 'term_id')::uuid, v_user,
          case when v_user is null then v_label end, v_role, 'set', v_value, v_reason, 'import', null, false);
        v_entries := v_entries + 1;
      end loop;
    end loop;
    if nullif(btrim(coalesce(v_row ->> 'note', '')), '') is not null then
      perform private.save_commitment_note(v_actor, p_school_year_id, v_user, case when v_user is null then v_label end,
                                           left(btrim(v_row ->> 'note'), 2000));
    end if;
    v_people := v_people + 1;
  end loop;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_imported', 'school_year', p_school_year_id::text,
    jsonb_build_object('terms', to_jsonb(v_terms), 'people', v_people, 'entries', v_entries,
      'skipped_blank', v_blank, 'skipped_zero', v_zero, 'skipped_unknown', v_unknown));
  return jsonb_build_object('people', v_people, 'entries', v_entries, 'skipped_blank', v_blank,
    'skipped_zero', v_zero, 'skipped_unknown', v_unknown);
end;
$function$;
revoke all on function public.admin_import_teaching_commitment(uuid, uuid[], jsonb, text) from public, anon;
grant execute on function public.admin_import_teaching_commitment(uuid, uuid[], jsonb, text) to authenticated;
