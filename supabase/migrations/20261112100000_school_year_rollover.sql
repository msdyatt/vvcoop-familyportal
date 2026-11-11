-- Start next school year: copy a year forward and say which households are returning.
-- ---------------------------------------------------------------------------
-- A school year was only a container. Starting a new one meant rebuilding the
-- timetable by hand and asking every household to register again. This adds:
--
--   * household_school_years  -- one small row per household per year, written
--     only when an administrator says a household is NOT coming back (or says
--     so explicitly that it is). No row means "returning", so every existing
--     year behaves exactly as it did before and nothing needs backfilling.
--   * copied_from_id on the tables a rollover copies, so running it twice
--     skips what is already there instead of copying it again.
--   * admin_rollover_preview / admin_rollover_school_year -- the same code path
--     twice: the preview runs the whole copy and rolls it back, so the counts an
--     administrator confirms are the counts the real run produces.
--   * admin_set_household_returning -- the undo (and the late "they are coming
--     after all"), one household at a time.
--
-- A household that is not returning keeps its account, its login and its
-- children. Nothing is deleted, deactivated or invited; it is simply left out of
-- that year's dues, document requests and reports.
--
-- Students are never copied (families choose classes in the enrollment window),
-- nor prerequisites, events, assignments, photos, expenses or anything signed.
-- ---------------------------------------------------------------------------

-- --- who is coming back ------------------------------------------------------
create table public.household_school_years (
  family_id uuid not null references public.families(id) on delete cascade,
  school_year_id uuid not null references public.school_years(id) on delete cascade,
  status text not null check (status in ('returning', 'not_returning')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz not null default now(),
  primary key (family_id, school_year_id)
);
create index household_school_years_year_idx on public.household_school_years (school_year_id, status);

comment on table public.household_school_years is
  'Per-household answer to "are you coming back this year". Absent row = returning. Written only by admin_rollover_school_year and admin_set_household_returning.';

alter table public.household_school_years enable row level security;
create policy household_school_years_admin_read on public.household_school_years
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.household_school_years as restrictive
  for all to authenticated using (private.aal_satisfied());
-- Read only for administrators (the policy above). The default grants on a new table
-- are wider than that, so they are taken back: every change goes through the
-- functions below, which run with their own rights.
revoke all on public.household_school_years from public, anon, authenticated;
grant select on public.household_school_years to authenticated;

-- --- what was copied from what -----------------------------------------------
-- Terms need no column: a year can hold one term per label already.
alter table public.class_blocks
  add column copied_from_id uuid references public.class_blocks(id) on delete set null;
alter table public.classes
  add column copied_from_id uuid references public.classes(id) on delete set null;
alter table public.requirements
  add column copied_from_id uuid references public.requirements(id) on delete set null;
alter table public.enrollment_periods
  add column copied_from_id uuid references public.enrollment_periods(id) on delete set null;

-- The backstop under the "skip what is already there" checks: even two clicks
-- landing at the same instant cannot leave two copies of one class in a year.
create unique index class_blocks_one_copy_per_year on public.class_blocks (school_year_id, copied_from_id) where copied_from_id is not null;
create unique index classes_one_copy_per_year on public.classes (school_year_id, copied_from_id) where copied_from_id is not null;
create unique index requirements_one_copy_per_year on public.requirements (school_year_id, copied_from_id) where copied_from_id is not null;
create unique index enrollment_periods_one_copy_per_year on public.enrollment_periods (school_year_id, copied_from_id) where copied_from_id is not null;

-- --- helpers -------------------------------------------------------------------
create or replace function private.require_rollover_admin()
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

-- The households a rollover can speak for: real, still held, with someone in them.
-- Reviewer (demo) households and households whose records are only retained for
-- billing are never offered.
create or replace function private.rollover_household_ids()
returns setof uuid language sql stable security definer set search_path to ''
as $$
  select f.id from public.families f
  where f.records_retained_at is null
    and exists (select 1 from public.family_members fm where fm.family_id = f.id)
    and not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id
                    where fm.family_id = f.id and p.is_demo);
$$;

-- True only when an administrator recorded that this household is not returning
-- in that year. Dues, document requests and reports leave such households out.
create or replace function private.household_not_returning(p_family uuid, p_year uuid)
returns boolean language sql stable security definer set search_path to ''
as $$
  select exists (select 1 from public.household_school_years h
                 where h.family_id = p_family and h.school_year_id = p_year and h.status = 'not_returning');
$$;

-- Opens every active requirement of a year to one household: a row for each
-- document, a charge for each dues item (the same amounts admin_open_dues uses).
-- Existing rows are left alone, so running it again changes nothing.
create or replace function private.open_year_requirements(p_family uuid, p_year uuid, p_actor uuid, out docs integer, out dues integer)
language plpgsql security definer set search_path to ''
as $function$
declare v_ids uuid[];
begin
  insert into public.family_requirements (requirement_id, family_id, status, updated_by)
  select r.id, p_family, 'outstanding', p_actor
  from public.requirements r
  where r.school_year_id = p_year and r.kind = 'document' and r.active
  on conflict (requirement_id, family_id) do nothing;
  get diagnostics docs = row_count;

  with ins as (
    insert into public.dues_charges (requirement_id, family_id, school_year_id, subtotal_cents, opened_by)
    select r.id, p_family, r.school_year_id,
      round((coalesce(r.amount_per_family, 0) + coalesce(r.amount_per_child, 0)
        * (select count(*) from public.children ch where ch.family_id = p_family and ch.active)) * 100)::integer,
      p_actor
    from public.requirements r
    where r.school_year_id = p_year and r.kind = 'dues' and r.active
    on conflict (requirement_id, family_id) do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from ins;
  dues := cardinality(v_ids);
  perform private.recompute_charge(c) from unnest(v_ids) c;
end;
$function$;

-- Takes a household back out of a year's requirements, but only if nothing has
-- happened on them yet. Anything signed, sent, paid, adjusted or noted is a
-- record the co-op keeps, so the change is refused and the administrator is told
-- why instead of the record being removed.
create or replace function private.close_year_requirements(p_family uuid, p_year uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
begin
  if exists (
    select 1 from public.family_requirements fr
    join public.requirements r on r.id = fr.requirement_id
    where r.school_year_id = p_year and fr.family_id = p_family
      and (fr.status <> 'outstanding' or fr.amount_paid > 0 or fr.signed_document_id is not null
           or fr.signed_at is not null or fr.note is not null)
  ) or exists (
    select 1 from public.sign_requests sr
    join public.requirements r on r.id = sr.requirement_id
    where r.school_year_id = p_year and sr.family_id = p_family and sr.status <> 'voided'
  ) or exists (
    select 1 from public.dues_charges c
    where c.school_year_id = p_year and c.family_id = p_family
      and (c.status <> 'open' or c.amount_paid_cents > 0 or c.adjustment_total_cents <> 0 or c.discount_total_cents > 0
           or exists (select 1 from public.dues_payments p where p.charge_id = c.id)
           or exists (select 1 from public.dues_adjustments a where a.charge_id = c.id)
           or exists (select 1 from public.dues_discount_lines d where d.charge_id = c.id)
           or exists (select 1 from public.dues_payment_plans pl where pl.charge_id = c.id))
  ) then
    raise exception 'This household already has paperwork or payments recorded for that year, so it cannot be marked as not returning. Waive the items from Documents and Dues instead.'
      using errcode = 'P0001';
  end if;

  delete from public.dues_charges c where c.school_year_id = p_year and c.family_id = p_family;
  delete from public.family_requirements fr
  using public.requirements r
  where r.id = fr.requirement_id and r.school_year_id = p_year and fr.family_id = p_family;
end;
$function$;

-- Records one household's answer for one year. A household that is not returning
-- has its untouched requirements taken back (or the change is refused, see
-- close_year_requirements). Opening requirements to a returning household is the
-- caller's next step, so the rollover can count what it opened.
-- Returns true when the answer changed.
create or replace function private.set_household_year_status(p_family uuid, p_year uuid, p_returning boolean, p_actor uuid)
returns boolean language plpgsql security definer set search_path to ''
as $function$
declare
  v_old text;
  v_new text := case when p_returning then 'returning' else 'not_returning' end;
begin
  select status into v_old from public.household_school_years where family_id = p_family and school_year_id = p_year;

  if not p_returning then
    perform private.close_year_requirements(p_family, p_year);
  end if;

  insert into public.household_school_years (family_id, school_year_id, status, decided_by)
  values (p_family, p_year, v_new, p_actor)
  on conflict (family_id, school_year_id) do update
    set status = excluded.status, decided_by = excluded.decided_by, decided_at = now()
    where public.household_school_years.status is distinct from excluded.status;

  return coalesce(v_old, 'returning') is distinct from v_new;
end;
$function$;

-- --- the rollover itself ---------------------------------------------------------
-- Does all the work and returns what it did. Called by the preview (which then
-- rolls everything back) and by the real run, so the two cannot disagree.
--
-- p_options: blocks_rooms, terms, classes, teachers, document_requirements,
--   dues_requirements, enrollment_windows, open_requirements (all default true).
-- p_returning: the households moving forward. Every other eligible household is
--   recorded as not returning.
-- p_terms: optional [{source_id, starts_on, ends_on}] to use instead of the
--   dates shifted forward by the difference between the two years.
create or replace function private.rollover_apply(
  p_source uuid, p_target uuid, p_options jsonb, p_returning uuid[], p_terms jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_src public.school_years;
  v_tgt public.school_years;
  v_shift integer;
  o_blocks boolean := coalesce((p_options ->> 'blocks_rooms')::boolean, true);
  o_terms boolean := coalesce((p_options ->> 'terms')::boolean, true);
  o_classes boolean := coalesce((p_options ->> 'classes')::boolean, true);
  o_teachers boolean := coalesce((p_options ->> 'teachers')::boolean, true);
  o_docs boolean := coalesce((p_options ->> 'document_requirements')::boolean, true);
  o_dues boolean := coalesce((p_options ->> 'dues_requirements')::boolean, true);
  o_windows boolean := coalesce((p_options ->> 'enrollment_windows')::boolean, true);
  o_open boolean := coalesce((p_options ->> 'open_requirements')::boolean, true);
  v_eligible uuid[];
  v_moving uuid[];
  v_family uuid;
  v_new_classes uuid[] := '{}';
  v_new_reqs uuid[] := '{}';
  c_blocks integer := 0; c_terms integer := 0; c_classes integer := 0; c_teachers integer := 0;
  c_class_terms integer := 0; c_docs integer := 0; c_dues integer := 0; c_windows integer := 0;
  s_blocks integer := 0; s_terms integer := 0; s_classes integer := 0; s_docs integer := 0;
  s_dues integer := 0; s_windows integer := 0;
  c_moving integer := 0; c_leaving integer := 0; c_changed integer := 0;
  c_open_docs integer := 0; c_open_dues integer := 0;
  v_d integer; v_u integer;
begin
  if p_source is null or p_target is null or p_source = p_target then
    raise exception 'Choose two different school years.' using errcode = 'P0001';
  end if;
  select * into v_src from public.school_years where id = p_source;
  select * into v_tgt from public.school_years where id = p_target;
  if v_src.id is null or v_tgt.id is null then
    raise exception 'That school year does not exist.' using errcode = 'P0001';
  end if;
  if p_returning is null then
    raise exception 'Choose which households are moving forward.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_terms, '[]'::jsonb)) <> 'array' then
    raise exception 'Term dates must be a list.' using errcode = 'P0001';
  end if;

  -- One rollover into a given year at a time; a second click waits, then finds
  -- everything already there and copies nothing.
  perform pg_advisory_xact_lock(hashtextextended('school_year_rollover:' || p_target::text, 0));

  v_shift := coalesce(nullif(extract(year from v_tgt.starts_on)::integer - extract(year from v_src.starts_on)::integer, 0), 1);

  -- Meeting blocks. A block already in the target (copied before, or the same
  -- label, weekday and start by hand) is not copied again.
  if o_blocks then
    select count(*) into s_blocks from public.class_blocks where school_year_id = p_source;
    insert into public.class_blocks (school_year_id, label, starts_at, ends_at, sort_order, day_of_week, copied_from_id)
    select p_target, b.label, b.starts_at, b.ends_at, b.sort_order, b.day_of_week, b.id
    from public.class_blocks b
    where b.school_year_id = p_source
      and not exists (select 1 from public.class_blocks t
                      where t.school_year_id = p_target
                        and (t.copied_from_id = b.id
                             or (t.label = b.label and t.day_of_week = b.day_of_week and t.starts_at = b.starts_at)));
    get diagnostics c_blocks = row_count;
    s_blocks := s_blocks - c_blocks;
  end if;

  -- Terms, dates moved forward unless the administrator typed others.
  if o_terms then
    select count(*) into s_terms from public.academic_terms where school_year_id = p_source;
    insert into public.academic_terms (school_year_id, label, starts_on, ends_on, sort_order)
    select p_target, st.label,
      coalesce((ov.item ->> 'starts_on')::date, (st.starts_on + make_interval(years => v_shift))::date),
      coalesce((ov.item ->> 'ends_on')::date, (st.ends_on + make_interval(years => v_shift))::date),
      st.sort_order
    from public.academic_terms st
    left join lateral (
      select e.item from jsonb_array_elements(coalesce(p_terms, '[]'::jsonb)) as e(item)
      where (e.item ->> 'source_id')::uuid = st.id limit 1
    ) ov on true
    where st.school_year_id = p_source
      and not exists (select 1 from public.academic_terms t where t.school_year_id = p_target and t.label = st.label);
    get diagnostics c_terms = row_count;
    s_terms := s_terms - c_terms;
  end if;

  -- Classes: active, non-demo ones. Students are never copied.
  if o_classes then
    select count(*) into s_classes from public.classes where school_year_id = p_source and active and not is_demo;
    with ins as (
      insert into public.classes (title, description, term, active, grades, is_elective, capacity, school_year_id, block_id, room_id, copied_from_id)
      select c.title, c.description, c.term, true, c.grades, c.is_elective, c.capacity, p_target,
        tb.id, case when o_blocks then c.room_id end, c.id
      from public.classes c
      left join public.class_blocks sb on sb.id = c.block_id
      left join lateral (
        select t.id from public.class_blocks t
        where t.school_year_id = p_target and sb.id is not null
          and (t.copied_from_id = sb.id
               or (t.label = sb.label and t.day_of_week = sb.day_of_week and t.starts_at = sb.starts_at))
        order by coalesce(t.copied_from_id = sb.id, false) desc, t.created_at limit 1
      ) tb on true
      where c.school_year_id = p_source and c.active and not c.is_demo
        and not exists (select 1 from public.classes t where t.school_year_id = p_target and t.copied_from_id = c.id)
      returning id
    )
    select coalesce(array_agg(id), '{}') into v_new_classes from ins;
    c_classes := cardinality(v_new_classes);
    s_classes := s_classes - c_classes;

    -- Which terms each new class runs in, matched by term label.
    insert into public.class_terms (class_id, term_id)
    select nc.id, tt.id
    from public.classes nc
    join public.class_terms sct on sct.class_id = nc.copied_from_id
    join public.academic_terms st on st.id = sct.term_id
    join public.academic_terms tt on tt.school_year_id = p_target and tt.label = st.label
    where nc.id = any (v_new_classes)
    on conflict do nothing;
    get diagnostics c_class_terms = row_count;

    -- Teachers, for the classes copied now, and only those still active.
    if o_teachers then
      insert into public.teacher_assignments (class_id, user_id, assignment_role)
      select nc.id, ta.user_id, ta.assignment_role
      from public.classes nc
      join public.teacher_assignments ta on ta.class_id = nc.copied_from_id
      join public.profiles p on p.id = ta.user_id and p.status = 'active'
      where nc.id = any (v_new_classes)
      on conflict (class_id, user_id) do nothing;
      get diagnostics c_teachers = row_count;
    end if;
  end if;

  -- Required documents and dues, same templates and amounts, due dates moved on.
  -- The same title in the same kind already in the target counts as already there.
  if o_docs or o_dues then
    select count(*) filter (where kind = 'document'), count(*) filter (where kind = 'dues')
    into s_docs, s_dues
    from public.requirements
    where school_year_id = p_source and active and ((kind = 'document' and o_docs) or (kind = 'dues' and o_dues));

    with ins as (
      insert into public.requirements (school_year_id, kind, title, description, active, sort_order, document_id, sign_template_id,
        amount_per_family, amount_per_child, payment_url, due_on, copied_from_id)
      select p_target, r.kind, r.title, r.description, true, r.sort_order, r.document_id, r.sign_template_id,
        r.amount_per_family, r.amount_per_child, r.payment_url,
        (r.due_on + make_interval(years => v_shift))::date, r.id
      from public.requirements r
      where r.school_year_id = p_source and r.active
        and ((r.kind = 'document' and o_docs) or (r.kind = 'dues' and o_dues))
        and not exists (select 1 from public.requirements t
                        where t.school_year_id = p_target
                          and (t.copied_from_id = r.id
                               or (t.kind = r.kind and lower(btrim(t.title)) = lower(btrim(r.title)))))
      returning id, kind
    )
    select coalesce(array_agg(id), '{}'),
           count(*) filter (where kind = 'document'), count(*) filter (where kind = 'dues')
    into v_new_reqs, c_docs, c_dues
    from ins;
    s_docs := s_docs - c_docs;
    s_dues := s_dues - c_dues;

    -- Monthly-plan choices that go with a dues item.
    insert into public.dues_requirement_options (requirement_id, monthly_enabled, monthly_count, monthly_first_due_on)
    select nr.id, o.monthly_enabled, o.monthly_count, (o.monthly_first_due_on + make_interval(years => v_shift))::date
    from public.requirements nr
    join public.dues_requirement_options o on o.requirement_id = nr.copied_from_id
    where nr.id = any (v_new_reqs)
    on conflict (requirement_id) do nothing;
  end if;

  -- Enrollment windows come over shut. Opening one is its own decision.
  if o_windows then
    select count(*) into s_windows from public.enrollment_periods where school_year_id = p_source;
    insert into public.enrollment_periods (title, opens_at, closes_at, active, school_year_id, electives_only, copied_from_id)
    select e.title, e.opens_at + make_interval(years => v_shift), e.closes_at + make_interval(years => v_shift),
      false, p_target, e.electives_only, e.id
    from public.enrollment_periods e
    where e.school_year_id = p_source
      and not exists (select 1 from public.enrollment_periods t where t.school_year_id = p_target and t.copied_from_id = e.id);
    get diagnostics c_windows = row_count;
    s_windows := s_windows - c_windows;
  end if;

  -- Households: everyone ticked moves forward, every other eligible household
  -- is recorded as not returning. Ids that are no longer eligible are ignored.
  select coalesce(array_agg(e.id), '{}') into v_eligible from private.rollover_household_ids() as e(id);
  select coalesce(array_agg(distinct m.id), '{}') into v_moving from unnest(p_returning) as m(id) where m.id = any (v_eligible);
  foreach v_family in array v_eligible loop
    if v_family = any (v_moving) then
      c_moving := c_moving + 1;
      if private.set_household_year_status(v_family, p_target, true, p_actor) then c_changed := c_changed + 1; end if;
      if o_open then
        select d.docs, d.dues into v_d, v_u from private.open_year_requirements(v_family, p_target, p_actor) d;
        c_open_docs := c_open_docs + v_d;
        c_open_dues := c_open_dues + v_u;
      end if;
    else
      c_leaving := c_leaving + 1;
      if private.set_household_year_status(v_family, p_target, false, p_actor) then c_changed := c_changed + 1; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'source', v_src.label, 'target', v_tgt.label, 'shift_years', v_shift,
    'copied', jsonb_build_object('blocks', c_blocks, 'terms', c_terms, 'classes', c_classes, 'teacher_assignments', c_teachers,
      'class_terms', c_class_terms, 'document_requirements', c_docs, 'dues_requirements', c_dues, 'enrollment_windows', c_windows),
    'already_there', jsonb_build_object('blocks', s_blocks, 'terms', s_terms, 'classes', s_classes,
      'document_requirements', s_docs, 'dues_requirements', s_dues, 'enrollment_windows', s_windows),
    'households', jsonb_build_object('moving_forward', c_moving, 'not_returning', c_leaving, 'changed', c_changed),
    'opened', jsonb_build_object('document_rows', c_open_docs, 'dues_charges', c_open_dues));
end;
$function$;

-- --- what administrators call -------------------------------------------------------
-- The households a rollover can speak for, with the answer already recorded for
-- the chosen year (returning when nothing is recorded).
create or replace function public.admin_rollover_households(p_year uuid)
returns table (family_id uuid, display_name text, last_name text, adults integer, children integer, status text, decided boolean)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_rollover_admin();
  return query
  select f.id, f.display_name, f.last_name,
    (select count(*)::integer from public.family_members fm where fm.family_id = f.id),
    (select count(*)::integer from public.children ch where ch.family_id = f.id and ch.active),
    coalesce(h.status, 'returning'), h.status is not null
  from private.rollover_household_ids() as e(id)
  join public.families f on f.id = e.id
  left join public.household_school_years h on h.family_id = f.id and h.school_year_id = p_year
  order by lower(f.display_name), f.id;
end;
$function$;

-- Counts only. Runs the whole rollover and then undoes it, so nothing is written.
create or replace function public.admin_rollover_preview(
  p_source uuid, p_target uuid, p_options jsonb, p_returning uuid[], p_terms jsonb default null)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_rollover_admin();
  v_result jsonb;
  v_detail text;
begin
  begin
    v_result := private.rollover_apply(p_source, p_target, coalesce(p_options, '{}'::jsonb), p_returning, p_terms, v_actor);
    raise exception 'preview only' using errcode = 'VVDRY', detail = v_result::text;
  exception when sqlstate 'VVDRY' then
    get stacked diagnostics v_detail = pg_exception_detail;
    return v_detail::jsonb;
  end;
end;
$function$;

-- The real thing, in one transaction. Safe to run again. Never changes which year
-- is current unless p_make_current is true.
create or replace function public.admin_rollover_school_year(
  p_source uuid, p_target uuid, p_options jsonb, p_returning uuid[], p_terms jsonb default null, p_make_current boolean default false)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_rollover_admin();
  v_result jsonb;
begin
  v_result := private.rollover_apply(p_source, p_target, coalesce(p_options, '{}'::jsonb), p_returning, p_terms, v_actor);

  if coalesce(p_make_current, false) then
    -- One current year at a time, so the outgoing one stands down first.
    update public.school_years set is_current = false where is_current and id <> p_target;
    update public.school_years set is_current = true where id = p_target and not is_current;
  end if;
  v_result := v_result || jsonb_build_object('made_current', coalesce(p_make_current, false));

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'school_year_rolled_over', 'school_year', p_target::text,
    v_result || jsonb_build_object('source_year_id', p_source, 'options', coalesce(p_options, '{}'::jsonb)));
  return v_result;
end;
$function$;

-- Reverses (or later changes) one household's answer for one year. Coming back
-- opens that year's requirements to it; leaving takes the untouched ones back and
-- is refused if anything has already been signed, sent or paid.
create or replace function public.admin_set_household_returning(p_year uuid, p_family uuid, p_returning boolean)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_rollover_admin();
begin
  if p_returning is null then
    raise exception 'Say whether the household is returning.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.school_years where id = p_year) then
    raise exception 'That school year does not exist.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from private.rollover_household_ids() as e(id) where e.id = p_family) then
    raise exception 'That household could not be found.' using errcode = 'P0001';
  end if;

  perform private.set_household_year_status(p_family, p_year, p_returning, v_actor);
  if p_returning then
    perform private.open_year_requirements(p_family, p_year, v_actor);
  end if;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'household_year_status_set', 'family', p_family::text,
    jsonb_build_object('school_year_id', p_year, 'status', case when p_returning then 'returning' else 'not_returning' end));
end;
$function$;

-- --- who may call what -------------------------------------------------------------
revoke all on function public.admin_rollover_households(uuid) from public, anon;
revoke all on function public.admin_rollover_preview(uuid, uuid, jsonb, uuid[], jsonb) from public, anon;
revoke all on function public.admin_rollover_school_year(uuid, uuid, jsonb, uuid[], jsonb, boolean) from public, anon;
revoke all on function public.admin_set_household_returning(uuid, uuid, boolean) from public, anon;
grant execute on function public.admin_rollover_households(uuid) to authenticated;
grant execute on function public.admin_rollover_preview(uuid, uuid, jsonb, uuid[], jsonb) to authenticated;
grant execute on function public.admin_rollover_school_year(uuid, uuid, jsonb, uuid[], jsonb, boolean) to authenticated;
grant execute on function public.admin_set_household_returning(uuid, uuid, boolean) to authenticated;

-- Internal pieces are not part of the API.
revoke all on function private.require_rollover_admin(), private.rollover_household_ids(),
  private.household_not_returning(uuid, uuid), private.open_year_requirements(uuid, uuid, uuid),
  private.close_year_requirements(uuid, uuid), private.set_household_year_status(uuid, uuid, boolean, uuid),
  private.rollover_apply(uuid, uuid, jsonb, uuid[], jsonb, uuid)
  from public, anon, authenticated;

-- --- leaving not-returning households out of the existing "everyone" actions -------
-- admin_open_dues and sign_send both fall back to "every household" when no
-- households are named. Each is the function as it stood, with one added line.

-- Opens a charge for every household (or just the ones named) from the
-- requirement's formula. Safe to run again: existing charges are left alone.
-- Households recorded as not returning in the requirement's year are skipped.
create or replace function public.admin_open_dues(p_requirement uuid, p_family_ids uuid[] default null)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  r public.requirements%rowtype;
  v_count integer;
begin
  select * into r from public.requirements where id = p_requirement and kind = 'dues';
  if not found then raise exception 'That is not a dues requirement.'; end if;

  with inserted as (
    insert into public.dues_charges (requirement_id, family_id, school_year_id, subtotal_cents, opened_by)
    select r.id, f.id, r.school_year_id,
      round((coalesce(r.amount_per_family, 0) + coalesce(r.amount_per_child, 0)
        * (select count(*) from public.children ch where ch.family_id = f.id and ch.active)) * 100)::integer,
      v_actor
    from public.families f
    where f.records_retained_at is null
      and (p_family_ids is null or f.id = any (p_family_ids))
      and not private.household_not_returning(f.id, r.school_year_id)
      and exists (select 1 from public.family_members fm where fm.family_id = f.id)
      and not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id where fm.family_id = f.id and p.is_demo)
    on conflict (requirement_id, family_id) do nothing
    returning id
  )
  select count(*) into v_count from inserted;

  perform private.recompute_charge(c.id) from public.dues_charges c where c.requirement_id = r.id
    and (p_family_ids is null or c.family_id = any (p_family_ids));
  perform private.audit_billing('dues_opened', 'requirement', r.id::text, jsonb_build_object('charges_created', v_count));
  return v_count;
end;
$function$;
revoke all on function public.admin_open_dues(uuid, uuid[]) from public, anon;
grant execute on function public.admin_open_dues(uuid, uuid[]) to authenticated;


-- Sending a required document to everyone who owes it.
create or replace function public.sign_send(
  p_template uuid,
  p_family_ids uuid[] default null,
  p_requirement uuid default null,
  p_sequential boolean default false,
  p_message text default null,
  p_due_on date default null,
  p_assignments jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_t public.sign_templates;
  v_req public.requirements;
  v_family uuid;
  v_targets uuid[];
  v_users uuid[];
  v_user uuid;
  v_request uuid;
  v_fr uuid;
  v_fr_status text;
  v_slot int;
  v_sent jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
begin
  perform private.sign_require_admin();
  select * into v_t from public.sign_templates where id = p_template for update;
  if not found then raise exception 'That document does not exist.' using errcode = 'P0001'; end if;
  if v_t.status <> 'ready' then
    raise exception 'Place a signature field for each signer before sending.' using errcode = 'P0001';
  end if;
  if v_message is not null and char_length(v_message) > 1000 then
    raise exception 'The note can be up to 1000 characters.' using errcode = 'P0001';
  end if;

  if p_requirement is not null then
    select * into v_req from public.requirements where id = p_requirement;
    if not found or v_req.kind <> 'document' then
      raise exception 'Pick a required document.' using errcode = 'P0001';
    end if;
    if v_req.sign_template_id is not null and v_req.sign_template_id <> p_template then
      raise exception 'That requirement already uses a different document.' using errcode = 'P0001';
    end if;
    update public.requirements set sign_template_id = p_template where id = p_requirement and sign_template_id is null;
  end if;

  if p_family_ids is not null then
    v_targets := p_family_ids;
  elsif p_requirement is not null then
    -- Every household that does not already have this requirement settled, whether or not
    -- it has been opened to them yet. A new school year's requirement starts with no rows,
    -- so this is what makes "send it to everyone who owes it" work at the start of a year.
    -- Demonstration households are never included.
    select coalesce(array_agg(f.id), '{}') into v_targets
    from public.families f
    where not exists (select 1 from public.family_requirements fr
                      where fr.requirement_id = p_requirement and fr.family_id = f.id and fr.status in ('complete', 'waived'))
      and not exists (select 1 from public.family_members fm join public.profiles pr on pr.id = fm.user_id
                      where fm.family_id = f.id and pr.is_demo)
      -- A household recorded as not returning in the requirement's year is not asked again.
      and not private.household_not_returning(f.id, v_req.school_year_id);
  else
    raise exception 'Choose households, or a requirement to send to.' using errcode = 'P0001';
  end if;

  foreach v_family in array v_targets loop
    if not exists (select 1 from public.families where id = v_family) then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'unknown_household');
      continue;
    end if;
    -- Already sent for this same requirement (or, with no requirement, still being signed).
    -- A copy signed for an earlier school year does not count: a new year's requirement is
    -- a different requirement, so the same document can go out again.
    if exists (select 1 from public.sign_requests r
               where r.template_id = p_template and r.family_id = v_family and r.status <> 'voided'
                 and (r.requirement_id is not distinct from p_requirement
                      or (p_requirement is null and r.status <> 'completed'))) then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_sent');
      continue;
    end if;

    if p_assignments ? v_family::text then
      select array_agg(u::uuid order by o) into v_users
      from jsonb_array_elements_text(p_assignments -> v_family::text) with ordinality as e(u, o);
    else
      select array_agg(user_id order by created_at, user_id) into v_users from (
        select fm.user_id, fm.created_at
        from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
        where fm.family_id = v_family
        order by fm.created_at, fm.user_id limit v_t.signers_required) x;
    end if;
    -- A household with fewer adults than the document has signers still gets it:
    -- the adults it has sign their own slots, in order, and fields for a slot
    -- nobody fills are left off the sealed copy. Only a household with no adult
    -- at all is skipped.
    if coalesce(cardinality(v_users), 0) = 0 then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'no_adult');
      continue;
    end if;
    if cardinality(v_users) > v_t.signers_required then
      raise exception 'This document has % signer slots, but % people were chosen.', v_t.signers_required, cardinality(v_users) using errcode = 'P0001';
    end if;
    if exists (
      select 1 from unnest(v_users) u
      where not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
                        where fm.family_id = v_family and fm.user_id = u)) then
      raise exception 'Every signer must be an active adult in that household.' using errcode = 'P0001';
    end if;
    if cardinality(v_users) = 2 and v_users[1] = v_users[2] then
      raise exception 'Choose two different people.' using errcode = 'P0001';
    end if;

    v_fr := null;
    if p_requirement is not null then
      select id, status into v_fr, v_fr_status from public.family_requirements
      where requirement_id = p_requirement and family_id = v_family;
      if v_fr_status = 'complete' or v_fr_status = 'waived' then
        v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_' || v_fr_status);
        continue;
      end if;
      if v_fr is null then
        insert into public.family_requirements (requirement_id, family_id, status, updated_by)
        values (p_requirement, v_family, 'sent', v_me) returning id into v_fr;
      else
        update public.family_requirements set status = 'sent', updated_by = v_me where id = v_fr;
      end if;
    end if;

    insert into public.sign_requests (template_id, family_id, requirement_id, family_requirement_id, title,
      original_path, original_sha256, page_count, signing_order, message, due_on, created_by)
    values (p_template, v_family, p_requirement, v_fr, v_t.title, v_t.storage_path, v_t.sha256, v_t.page_count,
      case when p_sequential then 'sequential' else 'any' end, v_message, p_due_on, v_me)
    returning id into v_request;

    v_slot := 0;
    foreach v_user in array v_users loop
      v_slot := v_slot + 1;
      insert into public.sign_signers (request_id, slot, user_id, display_name, email)
      select v_request, v_slot, p.id, coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)), p.email
      from public.profiles p where p.id = v_user;
    end loop;

    perform private.sign_log(v_request, null, 'created', jsonb_build_object('title', v_t.title, 'template_id', p_template, 'original_sha256', v_t.sha256));
    perform private.sign_log(v_request, null, 'sent', jsonb_build_object('signers', v_users, 'signing_order', case when p_sequential then 'sequential' else 'any' end));

    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select s.user_id, 'sign_request', 'Please sign: ' || v_t.title,
      coalesce(v_message, 'Veritas Village is asking you to sign this document.'),
      '/family-village/paperwork', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.user_id is not null;
    insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
    select s.email, 'Please sign: ' || v_t.title,
      '<p>Veritas Village is asking you to sign <strong>' || private.escape_html(v_t.title) || '</strong>.</p>'
        || coalesce('<p>' || private.escape_html(v_message) || '</p>', '')
        || '<p>Sign in to Family Village and open Paperwork to read and sign it: <a href="https://family.veritasvillage.org/family-village/paperwork">family.veritasvillage.org</a></p>',
      'sign_request', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.email is not null and s.email <> '';

    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_me, 'sign_request_sent', 'sign_request', v_request::text, jsonb_build_object('title', v_t.title, 'family_id', v_family));

    v_sent := v_sent || jsonb_build_object('request_id', v_request, 'family_id', v_family);
  end loop;

  return jsonb_build_object('sent', v_sent, 'skipped', v_skipped);
end;
$function$;
revoke all on function public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb) from public, anon, authenticated;
grant execute on function public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb) to authenticated;

