-- Grade-based class placement: History and Science place themselves, electives stay with families.
-- ---------------------------------------------------------------------------
-- The decision, in one paragraph
--
-- A class can carry a SUBJECT ("History", "Science"). A class that is not an elective
-- and has a subject is GRADE-ASSIGNED: each child is placed in the class of that
-- subject whose grades include the child's grade for the school year. That is the
-- whole model. There is no new "placement type" column, because the type is already
-- there: is_elective says families choose; a subject on a non-elective class says the
-- system places; a non-elective class with no subject stays what it was, placed by an
-- administrator by hand. (A check keeps a class from being both an elective and
-- grade-assigned.)
--
-- Grades are not stored per year. children.age_band is today's grade, and it only
-- moves when a new school year is made current. Placement for NEXT year therefore
-- cannot read age_band; it works the grade out from the birthdate against the target
-- year's own September 1 cutoff (the same rule the existing trigger uses), and uses
-- age_band as it stands for a child whose grade was set by hand or who has no
-- birthdate. Run again in the middle of a year, the same code gives the grade the
-- child has now, so a corrected birthdate or grade moves the child to the right class.
--
-- What it will and will not touch (enrollments.placed_by_grade marks its own rows):
--   * it never changes or removes a placement made any other way (an administrator
--     placing or withdrawing a child, a family choosing). A child already in, or
--     withdrawn from, a class of that subject is left exactly as they are;
--   * its own rows it does manage: a child who is now in the wrong grade's class is
--     moved, a waitlisted child is promoted when a seat opens, and running it again
--     with nothing changed changes nothing;
--   * capacity is respected as the roster reports already understand it: a full class
--     puts the child on the waitlist (enrollments.status = 'waitlisted'), never over
--     the limit. Families cannot self-enroll in a grade-assigned class at all;
--   * a child with no grade, a grade no class covers, or a time clash with a class
--     already held is not placed and appears in the report with the reason;
--   * only active children of households that are returning that year, the same
--     households the rollover works with.
-- Prerequisites are not checked, the same as when an administrator places a child.
-- ---------------------------------------------------------------------------

alter table public.classes
  add column subject text,
  add constraint classes_subject_not_blank check (subject is null or btrim(subject) <> ''),
  add constraint classes_subject_not_elective check (subject is null or not is_elective);

comment on column public.classes.subject is
  'Set on a non-elective class that places itself by grade: children go to the class of this subject whose grades include theirs. NULL means placed by hand (or an elective). Compared case-insensitively.';

alter table public.enrollments
  add column placed_by_grade boolean not null default false;

comment on column public.enrollments.placed_by_grade is
  'True only for rows written by grade-based placement. Those it may move or promote; every other row it leaves alone.';

-- --- the grade a child has in a given year ---------------------------------------
create or replace function private.grade_for_year(p_birthdate date, p_override boolean, p_age_band text, p_year uuid)
returns text language sql stable security definer set search_path to ''
as $$
  select case
    when p_override or p_birthdate is null then p_age_band
    else coalesce(private.grade_for_birthdate(p_birthdate, private.grade_cutoff_for_school_year(p_year)), p_age_band)
  end;
$$;

-- --- families never self-enroll in a grade-assigned class --------------------------
-- The shared eligibility check, unchanged from 20260903040901_class_capacity_and_prerequisites.sql
-- apart from one added line: cl.subject is null.
create or replace function private.enrollment_request_allowed(
  wanted_period_id uuid, wanted_class_id uuid, wanted_child_id uuid
) returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1
    from public.enrollment_periods ep
    join public.children ch on ch.id = wanted_child_id
    join public.classes cl on cl.id = wanted_class_id
    where ep.id = wanted_period_id
      and ep.active
      and now() between ep.opens_at and ep.closes_at
      and private.has_child_family_access(ch.id)
      and cl.active
      and cl.subject is null
      and (cardinality(cl.grades) = 0 or ch.age_band is null or ch.age_band = any (cl.grades))
      and private.class_has_capacity(cl.id)
      and private.child_meets_prerequisites(cl.id, ch.id)
      and not exists (
        select 1 from public.enrollment_requests er
        join public.classes other_class on other_class.id = er.class_id
        where er.period_id = wanted_period_id
          and er.child_id = wanted_child_id
          and er.status in ('requested','approved','waitlisted')
          and cl.block_id is not null
          and other_class.block_id = cl.block_id
          and er.class_id <> wanted_class_id
          and private.classes_terms_overlap(cl.id, other_class.id)
      )
      and not exists (
        select 1 from public.enrollments e
        join public.classes other_class on other_class.id = e.class_id
        where e.child_id = wanted_child_id and e.status = 'active'
          and cl.block_id is not null
          and other_class.block_id = cl.block_id
          and e.class_id <> wanted_class_id
          and private.classes_terms_overlap(cl.id, other_class.id)
      )
  );
$function$;

-- --- the placement itself ---------------------------------------------------------------
-- Writes enrollments and returns a report. p_families limits it to those households
-- (the rollover passes the ones moving forward); NULL means every returning household.
create or replace function private.place_children_by_grade(p_year uuid, p_actor uuid, p_families uuid[] default null)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_label text;
  v_items jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_skipped integer := 0;
  v_child record;
  v_subject record;
  v_cand record;
  v_clash text;
  v_manual text;
  v_own_class uuid;
  v_own_status text;
  v_grade text;
  v_target public.classes;
  v_has_seat boolean;
  v_from text;
  v_grade_order text[] := array['Pre-K','K','1','2','3','4','5','6','7','8','9','10','11','12'];
  v_g text;
  v_n integer;
  v_names text;
begin
  select label into v_label from public.school_years where id = p_year;
  if v_label is null then
    raise exception 'That school year does not exist.' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('grade_placement:' || p_year::text, 0));

  -- Problems with the classes themselves, found before anyone is placed.
  for v_subject in
    select lower(btrim(c.subject)) as key, (array_agg(btrim(c.subject) order by c.title, c.id))[1] as label
    from public.classes c
    where c.school_year_id = p_year and c.active and not c.is_demo and not c.is_elective and c.subject is not null
    group by lower(btrim(c.subject))
  loop
    select string_agg(c.title, ', ' order by c.title) into v_names
    from public.classes c
    where c.school_year_id = p_year and c.active and not c.is_demo and not c.is_elective
      and lower(btrim(c.subject)) = v_subject.key and cardinality(c.grades) = 0;
    if v_names is not null then
      v_warnings := v_warnings || jsonb_build_object('subject', v_subject.label, 'kind', 'no_grades',
        'detail', v_names || ' has no grades set, so nobody can be placed in it.');
    end if;
    foreach v_g in array v_grade_order loop
      select count(*), string_agg(c.title, ', ' order by c.title) into v_n, v_names
      from public.classes c
      where c.school_year_id = p_year and c.active and not c.is_demo and not c.is_elective
        and lower(btrim(c.subject)) = v_subject.key and v_g = any (c.grades);
      if v_n > 1 then
        v_warnings := v_warnings || jsonb_build_object('subject', v_subject.label, 'kind', 'overlap',
          'detail', 'Grade ' || v_g || ' is in more than one ' || v_subject.label || ' class (' || v_names || '). Children fill the first until it is full, then the next.');
      end if;
    end loop;
  end loop;

  for v_child in
    select ch.id, ch.first_name, ch.last_name, ch.birthdate, ch.age_band, ch.age_band_override, f.id as family_id, f.display_name as family
    from public.children ch
    join public.families f on f.id = ch.family_id
    where ch.active
      and ch.family_id in (select e from private.rollover_household_ids() as e)
      and (p_families is null or ch.family_id = any (p_families))
    order by lower(f.display_name), lower(ch.first_name), ch.id
  loop
    if private.household_not_returning(v_child.family_id, p_year) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_grade := private.grade_for_year(v_child.birthdate, v_child.age_band_override, v_child.age_band, p_year);

    for v_subject in
      select lower(btrim(c.subject)) as key, (array_agg(btrim(c.subject) order by c.title, c.id))[1] as label
      from public.classes c
      where c.school_year_id = p_year and c.active and not c.is_demo and not c.is_elective and c.subject is not null
      group by lower(btrim(c.subject))
      order by lower(btrim(c.subject))
    loop
      -- Anything done by hand in this subject this year stands.
      select c.title into v_manual
      from public.enrollments e join public.classes c on c.id = e.class_id
      where e.child_id = v_child.id and c.school_year_id = p_year and lower(btrim(c.subject)) = v_subject.key
        and not e.placed_by_grade and e.status in ('active', 'waitlisted')
      order by e.status limit 1;
      if found then
        v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
          'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'manual', 'class', v_manual,
          'detail', 'Placed by hand, left as it is.');
        continue;
      end if;
      select c.title into v_from
      from public.enrollments e join public.classes c on c.id = e.class_id
      where e.child_id = v_child.id and c.school_year_id = p_year and lower(btrim(c.subject)) = v_subject.key and e.status = 'withdrawn'
      limit 1;
      if found then
        v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
          'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'removed', 'class', v_from,
          'detail', 'Withdrawn from ' || v_from || ' by an administrator, so not placed again.');
        continue;
      end if;

      if v_grade is null then
        v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
          'family', v_child.family, 'subject', v_subject.label, 'grade', null, 'outcome', 'no_grade',
          'detail', 'No birthdate or grade on file.');
        continue;
      end if;

      -- This child's own earlier placement here, if grade placement made one.
      v_own_class := null; v_own_status := null;
      select e.class_id, e.status into v_own_class, v_own_status
      from public.enrollments e join public.classes c on c.id = e.class_id
      where e.child_id = v_child.id and c.school_year_id = p_year and lower(btrim(c.subject)) = v_subject.key
        and e.placed_by_grade and e.status in ('active', 'waitlisted')
      limit 1;

      v_target := null; v_has_seat := false;
      for v_cand in
        select c.* from public.classes c
        where c.school_year_id = p_year and c.active and not c.is_demo and not c.is_elective
          and lower(btrim(c.subject)) = v_subject.key and cardinality(c.grades) > 0 and v_grade = any (c.grades)
        order by (c.id = v_own_class) desc nulls last, cardinality(c.grades), lower(c.title), c.id
      loop
        if v_target is null then v_target := v_cand; end if;
        if v_cand.capacity is null or (
          select count(*) from public.enrollments e where e.class_id = v_cand.id and e.status = 'active' and e.child_id <> v_child.id
        ) < v_cand.capacity then
          v_target := v_cand; v_has_seat := true; exit;
        end if;
      end loop;

      if v_target.id is null then
        v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
          'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'no_class',
          'detail', 'No ' || v_subject.label || ' class is set up for grade ' || v_grade || '.');
        -- A placement of ours in a class that no longer fits goes; nothing replaces it.
        delete from public.enrollments e using public.classes c
          where c.id = e.class_id and e.child_id = v_child.id and e.placed_by_grade
            and c.school_year_id = p_year and lower(btrim(c.subject)) = v_subject.key and e.status in ('active', 'waitlisted');
        continue;
      end if;

      v_from := null;
      if v_own_class is not null then
        if v_own_class = v_target.id then
          if v_own_status = 'active' then
            v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
              'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'already', 'class', v_target.title);
            continue;
          elsif v_has_seat then
            update public.enrollments set status = 'active' where class_id = v_target.id and child_id = v_child.id;
            v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
              'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'promoted', 'class', v_target.title,
              'detail', 'A seat opened up.');
            continue;
          else
            v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
              'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'waitlisted', 'class', v_target.title,
              'detail', v_target.title || ' is full.');
            continue;
          end if;
        end if;
        -- Wrong class for the grade now: ours to correct.
        select title into v_from from public.classes where id = v_own_class;
        delete from public.enrollments where class_id = v_own_class and child_id = v_child.id;
      end if;

      -- A class held at the same time (any placement, however made) is not double-booked.
      select c2.title into v_clash
      from public.enrollments e2 join public.classes c2 on c2.id = e2.class_id
      where e2.child_id = v_child.id and e2.status = 'active' and e2.class_id <> v_target.id
        and v_target.block_id is not null and c2.block_id = v_target.block_id
        and private.classes_terms_overlap(v_target.id, c2.id)
      limit 1;
      if found then
        v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
          'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade, 'outcome', 'clash', 'class', v_target.title, 'from', v_from,
          'detail', v_target.title || ' meets at the same time as ' || v_clash || '.');
        continue;
      end if;

      insert into public.enrollments (class_id, child_id, status, placed_by_grade)
      values (v_target.id, v_child.id, case when v_has_seat then 'active' else 'waitlisted' end, true);
      v_items := v_items || jsonb_build_object('child_id', v_child.id, 'child', btrim(concat_ws(' ', v_child.first_name, v_child.last_name)),
        'family', v_child.family, 'subject', v_subject.label, 'grade', v_grade,
        'outcome', case when v_has_seat then 'placed' else 'waitlisted' end, 'class', v_target.title, 'from', v_from,
        'detail', case when v_has_seat then case when v_from is not null then 'Moved from ' || v_from || ' to match this year''s grade.' else null end
                       else v_target.title || ' is full.' end);
    end loop;
  end loop;

  return jsonb_build_object(
    'year_id', p_year, 'year', v_label,
    'skipped_not_returning', v_skipped,
    'counts', coalesce((select jsonb_object_agg(o, n) from (select i ->> 'outcome' as o, count(*) as n from jsonb_array_elements(v_items) i group by 1) t), '{}'::jsonb),
    'warnings', v_warnings,
    'items', v_items);
end;
$function$;

-- --- what administrators call ----------------------------------------------------------
-- Place (or re-place) a year's children by grade. p_dry_run runs the whole thing and
-- undoes it, so the report is exactly what a real run would do. The same function the
-- rollover calls, for corrections and for a grade that changes in the middle of a year.
create or replace function public.admin_place_children_by_grade(p_year uuid, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_rollover_admin();
  v_result jsonb;
  v_detail text;
begin
  if p_year is null or not exists (select 1 from public.school_years where id = p_year) then
    raise exception 'That school year does not exist.' using errcode = 'P0001';
  end if;
  if coalesce(p_dry_run, false) then
    begin
      v_result := private.place_children_by_grade(p_year, v_actor);
      raise exception 'preview only' using errcode = 'VVDRY', detail = v_result::text;
    exception when sqlstate 'VVDRY' then
      get stacked diagnostics v_detail = pg_exception_detail;
      return v_detail::jsonb || jsonb_build_object('dry_run', true);
    end;
  end if;

  v_result := private.place_children_by_grade(p_year, v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'grade_placement_run', 'school_year', p_year::text, (v_result #- '{items}') - 'year_id');
  return v_result || jsonb_build_object('dry_run', false);
end;
$function$;

revoke all on function public.admin_place_children_by_grade(uuid, boolean) from public, anon;
grant execute on function public.admin_place_children_by_grade(uuid, boolean) to authenticated;
revoke all on function private.grade_for_year(date, boolean, text, uuid), private.place_children_by_grade(uuid, uuid, uuid[])
  from public, anon, authenticated;

-- --- the rollover, with placement as one more option ------------------------------------
-- private.rollover_apply and public.admin_rollover_school_year as they stood in
-- 20261112100000_school_year_rollover.sql, with three changes: a copied class keeps its
-- subject; option place_children (off unless asked for) places the households moving
-- forward after the households are recorded; and the audit entry keeps the counts of a
-- placement but not its per-child list.

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
  o_place boolean := coalesce((p_options ->> 'place_children')::boolean, false);
  v_place jsonb;
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
      insert into public.classes (title, description, term, active, grades, is_elective, subject, capacity, school_year_id, block_id, room_id, copied_from_id)
      select c.title, c.description, c.term, true, c.grades, c.is_elective, c.subject, c.capacity, p_target,
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

  -- Grade-based placement, last, for the households that are moving forward (their
  -- answers are recorded just above). The preview runs this too and rolls it back.
  if o_place then
    v_place := private.place_children_by_grade(p_target, p_actor, v_moving);
  end if;

  return jsonb_build_object(
    'source', v_src.label, 'target', v_tgt.label, 'shift_years', v_shift,
    'copied', jsonb_build_object('blocks', c_blocks, 'terms', c_terms, 'classes', c_classes, 'teacher_assignments', c_teachers,
      'class_terms', c_class_terms, 'document_requirements', c_docs, 'dues_requirements', c_dues, 'enrollment_windows', c_windows),
    'already_there', jsonb_build_object('blocks', s_blocks, 'terms', s_terms, 'classes', s_classes,
      'document_requirements', s_docs, 'dues_requirements', s_dues, 'enrollment_windows', s_windows),
    'households', jsonb_build_object('moving_forward', c_moving, 'not_returning', c_leaving, 'changed', c_changed),
    'opened', jsonb_build_object('document_rows', c_open_docs, 'dues_charges', c_open_dues),
    'placement', v_place);
end;
$function$;

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
    (v_result #- '{placement,items}') || jsonb_build_object('source_year_id', p_source, 'options', coalesce(p_options, '{}'::jsonb)));
  return v_result;
end;
$function$;
