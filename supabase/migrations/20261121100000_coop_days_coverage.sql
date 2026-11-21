-- Co-op days, absences, covers and points (issue #151 with #129; builds on 20261121090000_teaching_commitment).
--
-- The tracker's Roles grid (the spreadsheet) says what each adult signed up for: how many of the periods they teach,
-- assist or monitor on a co-op day in each term. This adds what actually happened, day by day:
--
--   coop_days          The dates the co-op meets, per term. Admins fill a term with its weekly dates and cancel
--                      holidays. A term with no dates is counted as one representative day (as the spreadsheet did).
--   shifts             Not stored: on each co-op day, every class assignment of that term (lead = taught, assistant =
--                      assisted) and every hall monitor assignment is a shift. A shift is assumed to be worked.
--   coop_day_absences  "I can't make it" (one adult): that adult's shifts that day are released for others to cover.
--                      "Our family won't be there" (a household): all its adults' shifts are released and the day does
--                      not count towards the household's expectation (the children are not there either).
--   coop_day_covers    Someone covering a shift: claiming a released one, or logging afterwards that they covered for
--                      someone who did not come (a no-show, shown only to administrators).
--
-- Points, per adult and term (private.commitment_points): on each co-op day that has passed and was not cancelled,
-- an adult who was there earns their Roles-grid counts times the weights (default: teach 2, assist 1, hall monitor 1),
-- less the weight of any of their shifts someone else covered while they were not marked absent, plus the weight of
-- every shift they covered. An absent adult earns nothing for that day. A household's expected points are the days it
-- attended times the handbook's expectation in points (teach 1 x 2 + assist 2 x 1 = 4 by default); the balance is what
-- it earned less that. A negative balance is what the household should make up in the next block.
--
-- Members use these through the SECURITY DEFINER functions my_coop_days, set_my_coop_day_absence, cover_coop_shift
-- and withdraw_coop_cover (active members, never reviewers). The tables themselves are readable only by
-- administrators (the same check as the tracker).

-- --- settings: points per role -------------------------------------------------------------------------------------------
alter table public.teaching_commitment_settings
  add column teach_points smallint not null default 2 check (teach_points between 0 and 10),
  add column assist_points smallint not null default 1 check (assist_points between 0 and 10),
  add column hall_points smallint not null default 1 check (hall_points between 0 and 10);

create or replace function private.commitment_role_points(p_role text)
returns integer
language sql stable security definer set search_path to ''
as $function$
  select case p_role when 'taught' then s.teach_points when 'assisted' then s.assist_points
                     when 'hall_monitor' then s.hall_points else 0 end::integer
  from public.teaching_commitment_settings s where s.id = 'coop';
$function$;
revoke all on function private.commitment_role_points(text) from public, anon, authenticated;

create or replace function public.admin_save_commitment_points(p_teach integer, p_assist integer, p_hall integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  if p_teach is null or p_assist is null or p_hall is null
     or p_teach not between 0 and 10 or p_assist not between 0 and 10 or p_hall not between 0 and 10 then
    raise exception 'Points are whole numbers from 0 to 10.' using errcode = 'P0001';
  end if;
  update public.teaching_commitment_settings
     set teach_points = p_teach, assist_points = p_assist, hall_points = p_hall, updated_at = now(), updated_by = v_actor
   where id = 'coop';
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'teaching_commitment_points_saved', 'teaching_commitment_settings', 'coop',
    jsonb_build_object('teach_points', p_teach, 'assist_points', p_assist, 'hall_points', p_hall));
end;
$function$;
revoke all on function public.admin_save_commitment_points(integer, integer, integer) from public, anon;
grant execute on function public.admin_save_commitment_points(integer, integer, integer) to authenticated;

-- --- tables --------------------------------------------------------------------------------------------------------------
create table public.coop_days (
  id uuid primary key default gen_random_uuid(),
  term_id uuid not null references public.academic_terms(id) on delete cascade,
  day date not null,
  cancelled boolean not null default false,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint coop_days_term_day unique (term_id, day)
);
create index coop_days_day_idx on public.coop_days(day);

create table public.coop_day_absences (
  id uuid primary key default gen_random_uuid(),
  coop_day_id uuid not null references public.coop_days(id) on delete cascade,
  -- One of the two: a whole household, or one adult.
  family_id uuid references public.families(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  reason text check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint coop_day_absences_who check ((family_id is null) <> (user_id is null))
);
create unique index coop_day_absences_family on public.coop_day_absences(coop_day_id, family_id) where family_id is not null;
create unique index coop_day_absences_user on public.coop_day_absences(coop_day_id, user_id) where user_id is not null;

create table public.coop_day_covers (
  id uuid primary key default gen_random_uuid(),
  coop_day_id uuid not null references public.coop_days(id) on delete cascade,
  role text not null check (role in ('taught', 'assisted', 'hall_monitor')),
  -- The shift: a class (teaching or assisting) or a period (hall monitor).
  class_id uuid references public.classes(id) on delete cascade,
  block_id uuid references public.class_blocks(id) on delete cascade,
  covering_user_id uuid not null references public.profiles(id) on delete cascade,
  covered_user_id uuid not null references public.profiles(id) on delete cascade,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint coop_day_covers_shift check ((role = 'hall_monitor' and block_id is not null) or (role <> 'hall_monitor' and class_id is not null)),
  constraint coop_day_covers_not_self check (covering_user_id <> covered_user_id)
);
-- One cover per shift.
create unique index coop_day_covers_one on public.coop_day_covers
  (coop_day_id, covered_user_id, role, coalesce(class_id::text, 'b:' || block_id::text));
create index coop_day_covers_covering_idx on public.coop_day_covers(covering_user_id);

alter table public.coop_days enable row level security;
alter table public.coop_day_absences enable row level security;
alter table public.coop_day_covers enable row level security;
create policy coop_days_admin_read on public.coop_days for select to authenticated using (private.is_commitment_admin());
create policy coop_day_absences_admin_read on public.coop_day_absences for select to authenticated using (private.is_commitment_admin());
create policy coop_day_covers_admin_read on public.coop_day_covers for select to authenticated using (private.is_commitment_admin());
revoke all on public.coop_days, public.coop_day_absences, public.coop_day_covers from public, anon, authenticated;
grant select on public.coop_days, public.coop_day_absences, public.coop_day_covers to authenticated;
grant all on public.coop_days, public.coop_day_absences, public.coop_day_covers to service_role;

-- --- helpers ---------------------------------------------------------------------------------------------------------------
create or replace function private.coop_today()
returns date
language sql stable set search_path to ''
as $function$ select (now() at time zone 'America/Chicago')::date; $function$;
revoke all on function private.coop_today() from public, anon;
grant execute on function private.coop_today() to authenticated;

-- Every shift on a co-op day.
create or replace function private.coop_day_shifts(p_coop_day_id uuid)
returns table (user_id uuid, role text, class_id uuid, block_id uuid, title text, period text, starts_at time, sort_order integer)
language sql stable security definer set search_path to ''
as $function$
  with d as (
    select cd.id, cd.term_id, t.school_year_id
    from public.coop_days cd join public.academic_terms t on t.id = cd.term_id
    where cd.id = p_coop_day_id
  )
  select ta.user_id, case ta.assignment_role when 'lead' then 'taught' else 'assisted' end, c.id, c.block_id, c.title,
         b.label, b.starts_at, coalesce(b.sort_order, 99)
  from d
  join public.classes c on c.school_year_id = d.school_year_id and not c.is_demo
   and (exists (select 1 from public.class_terms ct where ct.class_id = c.id and ct.term_id = d.term_id)
        or not exists (select 1 from public.class_terms ct where ct.class_id = c.id))
  join public.teacher_assignments ta on ta.class_id = c.id
  join public.profiles p on p.id = ta.user_id and not p.is_demo and p.status <> 'removed'
  left join public.class_blocks b on b.id = c.block_id
  union all
  select h.user_id, 'hall_monitor', null::uuid, h.block_id, 'Hall monitor', b.label, b.starts_at, coalesce(b.sort_order, 99)
  from d
  join public.hall_monitor_assignments h on h.term_id = d.term_id
  join public.profiles p on p.id = h.user_id and not p.is_demo and p.status <> 'removed'
  join public.class_blocks b on b.id = h.block_id;
$function$;
revoke all on function private.coop_day_shifts(uuid) from public, anon, authenticated;

-- Whether an adult is out on a co-op day (marked themselves, or their household).
create or replace function private.coop_absent(p_coop_day_id uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.coop_day_absences a where a.coop_day_id = p_coop_day_id and a.user_id = p_user)
      or exists (select 1 from public.coop_day_absences a join public.family_members fm on fm.family_id = a.family_id
                 where a.coop_day_id = p_coop_day_id and fm.user_id = p_user);
$function$;
revoke all on function private.coop_absent(uuid, uuid) from public, anon, authenticated;

-- The shifts on a day with their state: released (owner out), who covers it, and whether a released assistant shift
-- still needs someone (the handbook: an assistant in a class that keeps two adults just tells the group).
create or replace function private.coop_day_shift_states(p_coop_day_id uuid)
returns table (user_id uuid, owner_name text, role text, class_id uuid, block_id uuid, title text, period text,
               starts_at time, sort_order integer, released boolean, cover_id uuid, covering_user_id uuid,
               covering_name text, needed boolean)
language sql stable security definer set search_path to ''
as $function$
  with s as (select * from private.coop_day_shifts(p_coop_day_id)),
  st as (
    select s.*, private.coop_absent(p_coop_day_id, s.user_id) as released,
           cv.id as cover_id, cv.covering_user_id
    from s
    left join public.coop_day_covers cv on cv.coop_day_id = p_coop_day_id and cv.covered_user_id = s.user_id
      and cv.role = s.role and coalesce(cv.class_id::text, 'b:' || cv.block_id::text) = coalesce(s.class_id::text, 'b:' || s.block_id::text)
  )
  select st.user_id, coalesce(nullif(btrim(op.display_name), ''), op.email), st.role, st.class_id, st.block_id, st.title,
         st.period, st.starts_at, st.sort_order, st.released, st.cover_id, st.covering_user_id,
         coalesce(nullif(btrim(cp.display_name), ''), cp.email),
         case when st.role <> 'assisted' then true
              else (select count(*) from st s2 where s2.class_id = st.class_id and (not s2.released or s2.cover_id is not null)) < 2 end
  from st
  join public.profiles op on op.id = st.user_id
  left join public.profiles cp on cp.id = st.covering_user_id;
$function$;
revoke all on function private.coop_day_shift_states(uuid) from public, anon, authenticated;

-- --- points ----------------------------------------------------------------------------------------------------------------
create or replace function private.commitment_points(p_school_year_id uuid)
returns table (person_key text, user_id uuid, term_id uuid, earned integer, days_present integer, days_absent integer,
               covers_given integer, no_shows integer)
language sql stable security definer set search_path to ''
as $function$
  with terms as (
    select t.id, exists (select 1 from public.coop_days cd where cd.term_id = t.id) as configured
    from public.academic_terms t where t.school_year_id = p_school_year_id
  ), past_days as (
    select cd.id, cd.term_id from public.coop_days cd join terms t on t.id = cd.term_id
    where not cd.cancelled and cd.day <= private.coop_today()
  ), cells as (
    select * from private.commitment_cells(p_school_year_id)
  ), base as (
    select c.person_key, c.user_id, c.term_id, sum(c.value * private.commitment_role_points(c.role))::integer as per_day
    from cells c group by 1, 2, 3
  ), absent as (
    select a.coop_day_id, a.user_id from public.coop_day_absences a where a.user_id is not null
    union
    select a.coop_day_id, fm.user_id from public.coop_day_absences a
    join public.family_members fm on fm.family_id = a.family_id where a.family_id is not null
  ), covers as (
    select cv.*, pd.term_id from public.coop_day_covers cv join past_days pd on pd.id = cv.coop_day_id
  ), scheduled as (
    select b.person_key, b.user_id, b.term_id,
           coalesce(sum(case when ab.user_id is null then b.per_day else 0 end), 0)::integer as pts,
           count(pd.id) filter (where ab.user_id is null)::integer as present,
           count(pd.id) filter (where ab.user_id is not null)::integer as away
    from base b
    join past_days pd on pd.term_id = b.term_id
    left join absent ab on ab.coop_day_id = pd.id and ab.user_id = b.user_id
    group by 1, 2, 3
  ), lost as (
    select cv.covered_user_id as user_id, cv.term_id, sum(private.commitment_role_points(cv.role))::integer as pts,
           count(*)::integer as n
    from covers cv
    where not exists (select 1 from absent ab where ab.coop_day_id = cv.coop_day_id and ab.user_id = cv.covered_user_id)
    group by 1, 2
  ), gave as (
    select cv.covering_user_id as user_id, cv.term_id, sum(private.commitment_role_points(cv.role))::integer as pts,
           count(*)::integer as n
    from covers cv group by 1, 2
  ), keys as (
    select b.person_key, b.user_id, b.term_id from base b
    union
    select g.user_id::text, g.user_id, g.term_id from gave g
  )
  select k.person_key, k.user_id, k.term_id,
         case when t.configured
              then greatest(0, coalesce(sc.pts, 0) - coalesce(l.pts, 0)) + coalesce(g.pts, 0)
              else coalesce(b.per_day, 0) end,
         case when t.configured then coalesce(sc.present, 0) else null end,
         case when t.configured then coalesce(sc.away, 0) else null end,
         coalesce(g.n, 0), coalesce(l.n, 0)
  from keys k
  join terms t on t.id = k.term_id
  left join base b on b.person_key = k.person_key and b.term_id = k.term_id
  left join scheduled sc on sc.person_key = k.person_key and sc.term_id = k.term_id
  left join lost l on l.user_id = k.user_id and l.term_id = k.term_id
  left join gave g on g.user_id = k.user_id and g.term_id = k.term_id;
$function$;
revoke all on function private.commitment_points(uuid) from public, anon, authenticated;

-- --- what admins read ------------------------------------------------------------------------------------------------------
create or replace function public.admin_commitment_days(p_school_year_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_year public.school_years%rowtype;
  v_settings public.teaching_commitment_settings%rowtype;
  v_today date := private.coop_today();
  v_day_points integer;
  v_result jsonb;
begin
  if p_school_year_id is null then
    select * into v_year from public.school_years where is_current order by starts_on desc nulls last limit 1;
  else
    select * into v_year from public.school_years where id = p_school_year_id;
  end if;
  select * into v_settings from public.teaching_commitment_settings where id = 'coop';
  if v_year.id is null then
    return jsonb_build_object('school_year', null, 'settings', to_jsonb(v_settings) - 'id', 'today', v_today);
  end if;
  v_day_points := v_settings.teach_target * v_settings.teach_points + v_settings.assist_target * v_settings.assist_points;

  with pts as (
    select * from private.commitment_points(v_year.id)
  ), labels as (
    select c.person_key, max(c.person_label) as label from private.commitment_cells(v_year.id) c group by 1
  ), terms as (
    select t.id, t.label, t.starts_on, t.ends_on, t.sort_order,
           (select count(*) from public.coop_days cd where cd.term_id = t.id)::integer as day_count,
           (t.starts_on <= v_today or exists (select 1 from private.commitment_cells(v_year.id) c
                                              where c.term_id = t.id and c.value > 0)) as checked
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
    select distinct on (fm.user_id) fm.user_id, h.id as household_id, h.name as household_name
    from public.family_members fm join households h on h.id = fm.family_id
    order by fm.user_id, h.name, h.id
  ), hterm as (
    select h.id as household_id, t.id as term_id,
           case when t.day_count > 0
                then (select count(*) from public.coop_days cd where cd.term_id = t.id and not cd.cancelled
                        and cd.day <= v_today
                        and not exists (select 1 from public.coop_day_absences a where a.coop_day_id = cd.id and a.family_id = h.id))
                else case when t.checked then 1 else 0 end end::integer as days_attended,
           case when t.day_count > 0
                then (select count(*) from public.coop_days cd where cd.term_id = t.id and not cd.cancelled
                        and cd.day <= v_today
                        and exists (select 1 from public.coop_day_absences a where a.coop_day_id = cd.id and a.family_id = h.id))
                else 0 end::integer as days_away,
           coalesce((select sum(p.earned) from pts p join home on home.user_id = p.user_id
                     where home.household_id = h.id and p.term_id = t.id), 0)::integer as earned
    from households h cross join terms t
  )
  select jsonb_build_object(
    'school_year', jsonb_build_object('id', v_year.id, 'label', v_year.label, 'is_current', v_year.is_current),
    'settings', to_jsonb(v_settings) - 'id',
    'today', v_today,
    'day_points', v_day_points,
    'terms', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'starts_on', t.starts_on,
                         'ends_on', t.ends_on, 'day_count', t.day_count, 'checked', t.checked) order by t.sort_order, t.starts_on)
                       from terms t), '[]'::jsonb),
    'households', coalesce((select jsonb_agg(jsonb_build_object(
        'id', h.id, 'name', h.name,
        'terms', (select jsonb_agg(jsonb_build_object('term_id', ht.term_id, 'days_attended', ht.days_attended,
                    'days_away', ht.days_away, 'earned', ht.earned, 'expected', ht.days_attended * v_day_points,
                    'balance', ht.earned - ht.days_attended * v_day_points))
                  from hterm ht where ht.household_id = h.id),
        'earned', (select coalesce(sum(ht.earned), 0) from hterm ht where ht.household_id = h.id),
        'expected', (select coalesce(sum(ht.days_attended), 0) * v_day_points from hterm ht where ht.household_id = h.id),
        'balance', (select coalesce(sum(ht.earned - ht.days_attended * v_day_points), 0) from hterm ht where ht.household_id = h.id)
      ) order by h.name) from households h), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(x.person order by x.name) from (
        select coalesce(nullif(btrim(pr.display_name), ''), pr.email, lb.label) as name,
               jsonb_build_object('key', p.person_key, 'user_id', p.user_id,
                 'name', coalesce(nullif(btrim(pr.display_name), ''), pr.email, lb.label),
                 'household_id', home.household_id, 'household_name', home.household_name,
                 'earned', sum(p.earned)::integer, 'covers_given', sum(p.covers_given)::integer,
                 'no_shows', sum(p.no_shows)::integer, 'days_absent', coalesce(sum(p.days_absent), 0)::integer,
                 'terms', jsonb_agg(jsonb_build_object('term_id', p.term_id, 'earned', p.earned, 'days_present', p.days_present,
                           'days_absent', p.days_absent, 'covers_given', p.covers_given, 'no_shows', p.no_shows))) as person
        from pts p
        left join public.profiles pr on pr.id = p.user_id
        left join home on home.user_id = p.user_id
        left join labels lb on lb.person_key = p.person_key
        where p.user_id is null or not pr.is_demo
        group by p.person_key, p.user_id, pr.display_name, pr.email, home.household_id, home.household_name, lb.label) x), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'id', cd.id, 'term_id', cd.term_id, 'day', cd.day, 'cancelled', cd.cancelled, 'note', cd.note,
        'absences', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'family_id', a.family_id, 'user_id', a.user_id,
                       'name', coalesce(f.last_name, f.display_name, nullif(btrim(ap.display_name), ''), ap.email), 'reason', a.reason))
                     from public.coop_day_absences a left join public.families f on f.id = a.family_id
                     left join public.profiles ap on ap.id = a.user_id where a.coop_day_id = cd.id), '[]'::jsonb),
        'shifts', case when cd.cancelled then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
                       'user_id', s.user_id, 'owner_name', s.owner_name, 'role', s.role, 'class_id', s.class_id,
                       'block_id', s.block_id, 'title', s.title, 'period', s.period, 'released', s.released,
                       'cover_id', s.cover_id, 'covering_user_id', s.covering_user_id, 'covering_name', s.covering_name,
                       'needed', s.needed) order by s.sort_order, s.title, s.role)
                     from private.coop_day_shift_states(cd.id) s
                     where s.released or s.cover_id is not null), '[]'::jsonb) end,
        'open_count', case when cd.cancelled then 0 else (select count(*) from private.coop_day_shift_states(cd.id) s
                       where s.released and s.cover_id is null and s.needed) end
      ) order by cd.day) from public.coop_days cd join terms t on t.id = cd.term_id), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name) order by h.name) from households h), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(nullif(btrim(p.display_name), ''), p.email),
                           'household_name', home.household_name) order by coalesce(nullif(btrim(p.display_name), ''), p.email))
                         from public.profiles p left join home on home.user_id = p.id
                         where p.status = 'active' and not p.is_demo), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.admin_commitment_days(uuid) from public, anon;
grant execute on function public.admin_commitment_days(uuid) to authenticated;

-- --- co-op days (admin) ----------------------------------------------------------------------------------------------------
-- Fills a term with its weekly co-op dates (the weekday the periods are on; Friday by default). Returns how many were added.
create or replace function public.admin_generate_coop_days(p_term_id uuid, p_weekday integer default null)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_term public.academic_terms%rowtype;
  v_weekday integer;
  v_added integer;
begin
  select * into v_term from public.academic_terms where id = p_term_id;
  if v_term.id is null then raise exception 'Choose a term.' using errcode = 'P0001'; end if;
  v_weekday := coalesce(p_weekday,
    (select b.day_of_week from public.class_blocks b where b.school_year_id = v_term.school_year_id
     group by b.day_of_week order by count(*) desc, b.day_of_week desc limit 1), 5);
  if v_weekday not between 0 and 6 then raise exception 'Choose a day of the week.' using errcode = 'P0001'; end if;
  insert into public.coop_days (term_id, day, created_by)
  select p_term_id, d::date, v_actor
  from generate_series(v_term.starts_on::timestamp, v_term.ends_on::timestamp, interval '1 day') d
  where extract(dow from d)::integer = v_weekday
  on conflict (term_id, day) do nothing;
  get diagnostics v_added = row_count;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_days_generated', 'academic_term', p_term_id::text, jsonb_build_object('weekday', v_weekday, 'added', v_added));
  return v_added;
end;
$function$;
revoke all on function public.admin_generate_coop_days(uuid, integer) from public, anon;
grant execute on function public.admin_generate_coop_days(uuid, integer) to authenticated;

-- Adds a date, cancels one (a holiday: it stays listed and counts for no one), restores it, or removes it.
create or replace function public.admin_set_coop_day(p_term_id uuid, p_day date, p_action text, p_note text default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_commitment_admin();
  v_term public.academic_terms%rowtype;
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_term from public.academic_terms where id = p_term_id;
  if v_term.id is null then raise exception 'Choose a term.' using errcode = 'P0001'; end if;
  if p_day is null or p_day not between v_term.starts_on and v_term.ends_on then
    raise exception 'Choose a date within the term.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 200 then raise exception 'Keep the note to 200 characters.' using errcode = 'P0001'; end if;
  select id into v_id from public.coop_days where term_id = p_term_id and day = p_day;
  if p_action = 'add' then
    insert into public.coop_days (term_id, day, note, created_by) values (p_term_id, p_day, v_note, v_actor)
    on conflict (term_id, day) do update set cancelled = false, note = coalesce(excluded.note, public.coop_days.note);
  elsif p_action in ('cancel', 'restore') then
    if v_id is null then raise exception 'That date is not a co-op day.' using errcode = 'P0001'; end if;
    update public.coop_days set cancelled = (p_action = 'cancel'), note = coalesce(v_note, note) where id = v_id;
  elsif p_action = 'remove' then
    if v_id is null then raise exception 'That date is not a co-op day.' using errcode = 'P0001'; end if;
    if exists (select 1 from public.coop_day_absences where coop_day_id = v_id)
       or exists (select 1 from public.coop_day_covers where coop_day_id = v_id) then
      raise exception 'Absences or covers are recorded for that day; cancel it instead.' using errcode = 'P0001';
    end if;
    delete from public.coop_days where id = v_id;
  else
    raise exception 'Unknown action.' using errcode = 'P0001';
  end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'coop_day_' || p_action, 'academic_term', p_term_id::text, jsonb_build_object('day', p_day, 'note', v_note));
end;
$function$;
revoke all on function public.admin_set_coop_day(uuid, date, text, text) from public, anon;
grant execute on function public.admin_set_coop_day(uuid, date, text, text) to authenticated;

-- --- absences and covers: one implementation for members and admins ---------------------------------------------------------
create or replace function private.set_coop_absence(
  p_actor uuid, p_coop_day_id uuid, p_family_id uuid, p_user_id uuid, p_absent boolean, p_reason text, p_admin boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_day public.coop_days%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_changed integer;
begin
  select * into v_day from public.coop_days where id = p_coop_day_id;
  if v_day.id is null then raise exception 'That co-op day was not found.' using errcode = 'P0001'; end if;
  if v_day.cancelled then raise exception 'There is no co-op that day.' using errcode = 'P0001'; end if;
  if not p_admin and v_day.day < private.coop_today() then
    raise exception 'That day has passed. Ask an administrator to change it.' using errcode = 'P0001';
  end if;
  if (p_family_id is null) = (p_user_id is null) then raise exception 'Choose a household or a person.' using errcode = 'P0001'; end if;
  if v_reason is not null and char_length(v_reason) > 300 then raise exception 'Keep the reason to 300 characters.' using errcode = 'P0001'; end if;

  if coalesce(p_absent, false) then
    insert into public.coop_day_absences (coop_day_id, family_id, user_id, reason, created_by)
    values (p_coop_day_id, p_family_id, p_user_id, v_reason, p_actor)
    on conflict do nothing;
  else
    -- Someone already covering a shift of a person who would no longer be out would be left covering someone who
    -- came: refuse for members.
    if not p_admin and exists (
      select 1 from public.coop_day_covers cv
      where cv.coop_day_id = p_coop_day_id
        and ((p_user_id is not null and cv.covered_user_id = p_user_id
              and not exists (select 1 from public.coop_day_absences a join public.family_members fm on fm.family_id = a.family_id
                              where a.coop_day_id = p_coop_day_id and fm.user_id = p_user_id))
          or (p_family_id is not null
              and cv.covered_user_id in (select fm.user_id from public.family_members fm where fm.family_id = p_family_id)
              and not exists (select 1 from public.coop_day_absences a
                              where a.coop_day_id = p_coop_day_id and a.user_id = cv.covered_user_id)))) then
      raise exception 'Someone is already covering one of these shifts. Ask them, or an administrator, to change it.' using errcode = 'P0001';
    end if;
    delete from public.coop_day_absences a
     where a.coop_day_id = p_coop_day_id
       and (case when p_user_id is not null then a.user_id = p_user_id else a.family_id = p_family_id end);
  end if;
  get diagnostics v_changed = row_count;
  if v_changed > 0 then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (p_actor, case when p_absent then 'coop_absence_marked' else 'coop_absence_withdrawn' end, 'coop_day',
      p_coop_day_id::text, jsonb_strip_nulls(jsonb_build_object('day', v_day.day, 'family_id', p_family_id,
        'user_id', p_user_id, 'reason', v_reason, 'by_admin', p_admin)));
  end if;
end;
$function$;
revoke all on function private.set_coop_absence(uuid, uuid, uuid, uuid, boolean, text, boolean) from public, anon, authenticated;

create or replace function private.record_coop_cover(
  p_actor uuid, p_coop_day_id uuid, p_role text, p_class_id uuid, p_block_id uuid, p_covered_user_id uuid,
  p_covering_user_id uuid, p_note text, p_admin boolean)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_day public.coop_days%rowtype;
  v_today date := private.coop_today();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_shift record;
  v_id uuid;
begin
  select * into v_day from public.coop_days where id = p_coop_day_id;
  if v_day.id is null then raise exception 'That co-op day was not found.' using errcode = 'P0001'; end if;
  if v_day.cancelled then raise exception 'There is no co-op that day.' using errcode = 'P0001'; end if;
  if not p_admin and v_day.day < v_today - 14 then
    raise exception 'Covers can be logged for up to two weeks after the day. Ask an administrator.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_covering_user_id and p.status = 'active' and not p.is_demo) then
    raise exception 'Choose an active member to cover.' using errcode = 'P0001';
  end if;
  if p_covering_user_id = p_covered_user_id then raise exception 'That is already their own shift.' using errcode = 'P0001'; end if;
  if v_note is not null and char_length(v_note) > 300 then raise exception 'Keep the note to 300 characters.' using errcode = 'P0001'; end if;

  select * into v_shift from private.coop_day_shift_states(p_coop_day_id) s
  where s.user_id = p_covered_user_id and s.role = p_role
    and (case when p_role = 'hall_monitor' then s.block_id = p_block_id else s.class_id = p_class_id end)
  limit 1;
  if not found then raise exception 'That shift is not on the schedule for that day.' using errcode = 'P0001'; end if;
  if v_shift.cover_id is not null then raise exception 'Someone is already covering that shift.' using errcode = 'P0001'; end if;
  -- Before the day, only shifts the owner has released can be taken. On the day or after, a cover can also be logged
  -- for someone who did not come.
  if not p_admin and not v_shift.released and v_day.day > v_today then
    raise exception 'That shift has not been released.' using errcode = 'P0001';
  end if;

  insert into public.coop_day_covers (coop_day_id, role, class_id, block_id, covering_user_id, covered_user_id, note, created_by)
  values (p_coop_day_id, p_role, case when p_role = 'hall_monitor' then null else p_class_id end,
          case when p_role = 'hall_monitor' then p_block_id else v_shift.block_id end,
          p_covering_user_id, p_covered_user_id, v_note, p_actor)
  returning id into v_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (p_actor, 'coop_shift_covered', 'coop_day', p_coop_day_id::text,
    jsonb_strip_nulls(jsonb_build_object('day', v_day.day, 'role', p_role, 'title', v_shift.title, 'period', v_shift.period,
      'covering_user_id', p_covering_user_id, 'covered_user_id', p_covered_user_id, 'released', v_shift.released,
      'note', v_note, 'by_admin', p_admin)));
  return v_id;
end;
$function$;
revoke all on function private.record_coop_cover(uuid, uuid, text, uuid, uuid, uuid, uuid, text, boolean) from public, anon, authenticated;

create or replace function private.remove_coop_cover(p_actor uuid, p_cover_id uuid, p_reason text, p_admin boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_cover public.coop_day_covers%rowtype;
  v_day date;
begin
  select * into v_cover from public.coop_day_covers where id = p_cover_id;
  if v_cover.id is null then raise exception 'That cover was not found.' using errcode = 'P0001'; end if;
  select day into v_day from public.coop_days where id = v_cover.coop_day_id;
  if not p_admin then
    if v_cover.covering_user_id <> p_actor then raise exception 'Only the person covering can withdraw it.' using errcode = '42501'; end if;
    if v_day < private.coop_today() - 14 then raise exception 'Ask an administrator to change an older cover.' using errcode = 'P0001'; end if;
  end if;
  delete from public.coop_day_covers where id = p_cover_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (p_actor, 'coop_cover_withdrawn', 'coop_day', v_cover.coop_day_id::text,
    jsonb_strip_nulls(jsonb_build_object('day', v_day, 'role', v_cover.role, 'covering_user_id', v_cover.covering_user_id,
      'covered_user_id', v_cover.covered_user_id, 'reason', nullif(btrim(coalesce(p_reason, '')), ''), 'by_admin', p_admin)));
end;
$function$;
revoke all on function private.remove_coop_cover(uuid, uuid, text, boolean) from public, anon, authenticated;

-- Admin wrappers: any date, anyone.
create or replace function public.admin_set_coop_absence(
  p_coop_day_id uuid, p_family_id uuid, p_user_id uuid, p_absent boolean, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  perform private.set_coop_absence(v_actor, p_coop_day_id, p_family_id, p_user_id, p_absent, p_reason, true);
end;
$function$;
revoke all on function public.admin_set_coop_absence(uuid, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_coop_absence(uuid, uuid, uuid, boolean, text) to authenticated;

create or replace function public.admin_record_coop_cover(
  p_coop_day_id uuid, p_role text, p_class_id uuid, p_block_id uuid, p_covered_user_id uuid, p_covering_user_id uuid, p_note text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  return private.record_coop_cover(v_actor, p_coop_day_id, p_role, p_class_id, p_block_id, p_covered_user_id,
                                   p_covering_user_id, p_note, true);
end;
$function$;
revoke all on function public.admin_record_coop_cover(uuid, text, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.admin_record_coop_cover(uuid, text, uuid, uuid, uuid, uuid, text) to authenticated;

create or replace function public.admin_remove_coop_cover(p_cover_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_commitment_admin();
begin
  perform private.remove_coop_cover(v_actor, p_cover_id, p_reason, true);
end;
$function$;
revoke all on function public.admin_remove_coop_cover(uuid, text) from public, anon;
grant execute on function public.admin_remove_coop_cover(uuid, text) to authenticated;

-- --- members ---------------------------------------------------------------------------------------------------------------
create or replace function private.require_coop_member()
returns uuid
language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.is_active_user() or private.is_demo_user() then
    raise exception 'Please sign in.' using errcode = '42501';
  end if;
  return v;
end;
$function$;
revoke all on function private.require_coop_member() from public, anon;
grant execute on function private.require_coop_member() to authenticated;

-- The caller's household (the first by name, in the rare case of two).
create or replace function private.my_household(p_user uuid)
returns uuid
language sql stable security definer set search_path to ''
as $function$
  select fm.family_id from public.family_members fm join public.families f on f.id = fm.family_id
  where fm.user_id = p_user order by coalesce(f.last_name, f.display_name), f.id limit 1;
$function$;
revoke all on function private.my_household(uuid) from public, anon, authenticated;

-- The co-op days from two weeks ago to ten weeks ahead, in the current school year: the caller's shifts, whether they or
-- their household are out, shifts others have released, the caller's covers, and (on and after the day) shifts that
-- can be logged as covered for someone who did not come.
create or replace function public.my_coop_days()
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_coop_member();
  v_family uuid := private.my_household(v_me);
  v_today date := private.coop_today();
  v_result jsonb;
begin
  select jsonb_build_object(
    'today', v_today,
    'household', (select jsonb_build_object('id', f.id, 'name', coalesce(nullif(btrim(f.last_name), ''), f.display_name))
                  from public.families f where f.id = v_family),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'id', cd.id, 'day', cd.day, 'term', t.label, 'cancelled', cd.cancelled, 'note', cd.note,
        'me_absent', exists (select 1 from public.coop_day_absences a where a.coop_day_id = cd.id and a.user_id = v_me),
        'family_absent', v_family is not null and exists (select 1 from public.coop_day_absences a
                                                          where a.coop_day_id = cd.id and a.family_id = v_family),
        'mine', coalesce((select jsonb_agg(jsonb_build_object('role', s.role, 'class_id', s.class_id, 'block_id', s.block_id,
                    'title', s.title, 'period', s.period, 'starts_at', s.starts_at, 'released', s.released,
                    'covering_name', s.covering_name) order by s.sort_order, s.title)
                  from private.coop_day_shift_states(cd.id) s where s.user_id = v_me), '[]'::jsonb),
        'open', coalesce((select jsonb_agg(jsonb_build_object('role', s.role, 'class_id', s.class_id, 'block_id', s.block_id,
                    'title', s.title, 'period', s.period, 'starts_at', s.starts_at, 'owner_id', s.user_id,
                    'owner_name', s.owner_name, 'needed', s.needed) order by s.needed desc, s.sort_order, s.title)
                  from private.coop_day_shift_states(cd.id) s
                  where s.released and s.cover_id is null and s.user_id <> v_me), '[]'::jsonb),
        'my_covers', coalesce((select jsonb_agg(jsonb_build_object('id', cv.id, 'role', cv.role,
                    'title', coalesce(c.title, 'Hall monitor'), 'period', b.label, 'owner_name',
                    coalesce(nullif(btrim(op.display_name), ''), op.email)))
                  from public.coop_day_covers cv left join public.classes c on c.id = cv.class_id
                  left join public.class_blocks b on b.id = cv.block_id
                  join public.profiles op on op.id = cv.covered_user_id
                  where cv.coop_day_id = cd.id and cv.covering_user_id = v_me), '[]'::jsonb),
        'loggable', case when cd.day <= v_today and not cd.cancelled then coalesce((select jsonb_agg(jsonb_build_object(
                    'role', s.role, 'class_id', s.class_id, 'block_id', s.block_id, 'title', s.title, 'period', s.period,
                    'owner_id', s.user_id, 'owner_name', s.owner_name) order by s.sort_order, s.title)
                  from private.coop_day_shift_states(cd.id) s
                  where not s.released and s.cover_id is null and s.user_id <> v_me), '[]'::jsonb) else '[]'::jsonb end
      ) order by cd.day)
      from public.coop_days cd
      join public.academic_terms t on t.id = cd.term_id
      join public.school_years y on y.id = t.school_year_id and y.is_current
      where cd.day between v_today - 14 and v_today + 70), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;
revoke all on function public.my_coop_days() from public, anon;
grant execute on function public.my_coop_days() to authenticated;

-- "I can't make it" (p_scope 'me') or "Our family won't be there" ('family'), or taking it back (p_absent false).
create or replace function public.set_my_coop_day_absence(p_coop_day_id uuid, p_scope text, p_absent boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_coop_member();
  v_family uuid;
begin
  if p_scope = 'family' then
    v_family := private.my_household(v_me);
    if v_family is null then raise exception 'You are not in a household.' using errcode = 'P0001'; end if;
    perform private.set_coop_absence(v_me, p_coop_day_id, v_family, null, p_absent, p_reason, false);
  elsif p_scope = 'me' then
    perform private.set_coop_absence(v_me, p_coop_day_id, null, v_me, p_absent, p_reason, false);
  else
    raise exception 'Choose yourself or your household.' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function public.set_my_coop_day_absence(uuid, text, boolean, text) from public, anon;
grant execute on function public.set_my_coop_day_absence(uuid, text, boolean, text) to authenticated;

-- The caller covers someone's shift: a released one, or (on or after the day) one whose person did not come.
create or replace function public.cover_coop_shift(
  p_coop_day_id uuid, p_role text, p_class_id uuid, p_block_id uuid, p_covered_user_id uuid, p_note text default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_coop_member();
begin
  return private.record_coop_cover(v_me, p_coop_day_id, p_role, p_class_id, p_block_id, p_covered_user_id, v_me, p_note, false);
end;
$function$;
revoke all on function public.cover_coop_shift(uuid, text, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.cover_coop_shift(uuid, text, uuid, uuid, uuid, text) to authenticated;

create or replace function public.withdraw_coop_cover(p_cover_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_coop_member();
begin
  perform private.remove_coop_cover(v_me, p_cover_id, null, false);
end;
$function$;
revoke all on function public.withdraw_coop_cover(uuid) from public, anon;
grant execute on function public.withdraw_coop_cover(uuid) to authenticated;
