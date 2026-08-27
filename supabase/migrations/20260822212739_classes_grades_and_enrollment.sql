-- Grades, electives, school-year scoping, and enrollment periods
-- ---------------------------------------------------------------------------
-- classes.age_band was free text, so a class spanning several grades had no way
-- to say so. It becomes grades[] -- a class can cover Pre-K through 12 in any
-- combination, which is what happens when a co-op combines age groups to make
-- a class viable.
--
-- Classes also gain a school year, so next year's timetable can be built
-- alongside this one, and an is_elective flag, because only electives are
-- chosen during an enrollment window.
--
-- enrollment_periods and enrollment_requests already existed -- created by hand,
-- never in a migration, referenced by private.enrollment_request_allowed and by
-- nothing else. They are wired up here rather than replaced.
-- ---------------------------------------------------------------------------

-- --- classes ---------------------------------------------------------------
alter table public.classes
  add column if not exists grades text[] not null default '{}',
  add column if not exists is_elective boolean not null default false,
  add column if not exists school_year_id uuid references public.school_years(id) on delete set null;

comment on column public.classes.grades is
  'Grades this class covers, e.g. {K,1,2}. Empty means unspecified. Replaces the free-text age_band.';

-- Carry any existing age_band text across as a single entry so nothing is lost;
-- an administrator can re-pick properly from the dropdown afterwards.
update public.classes
set grades = array[age_band]
where age_band is not null and age_band <> '' and cardinality(grades) = 0;

-- Everything currently in the timetable belongs to the current year.
update public.classes c
set school_year_id = (select y.id from public.school_years y where y.is_current limit 1)
where c.school_year_id is null;

create index if not exists classes_school_year_idx on public.classes(school_year_id);

-- --- enrollment periods ----------------------------------------------------
alter table public.enrollment_periods
  add column if not exists school_year_id uuid references public.school_years(id) on delete cascade,
  add column if not exists electives_only boolean not null default true;

comment on column public.enrollment_periods.electives_only is
  'When true the window only governs elective classes; core classes are placed by administrators.';

alter table public.enrollment_periods enable row level security;
alter table public.enrollment_requests enable row level security;

-- Families need to see when a window is open in order to use it.
drop policy if exists enrollment_periods_read on public.enrollment_periods;
create policy enrollment_periods_read on public.enrollment_periods
  for select to authenticated using (private.is_active_user());

drop policy if exists enrollment_periods_admin_write on public.enrollment_periods;
create policy enrollment_periods_admin_write on public.enrollment_periods
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

-- A family sees its own requests; administrators and the class's teacher see
-- the ones that concern them.
drop policy if exists enrollment_requests_read on public.enrollment_requests;
create policy enrollment_requests_read on public.enrollment_requests
  for select to authenticated
  using (
    private.has_role('admin')
    or private.teaches_class(class_id)
    or private.has_child_family_access(child_id)
  );

-- Requesting is gated on the window being open, which is exactly what the
-- pre-existing private.enrollment_request_allowed was written for.
drop policy if exists enrollment_requests_family_write on public.enrollment_requests;
create policy enrollment_requests_family_write on public.enrollment_requests
  for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and private.has_child_family_access(child_id)
    and private.enrollment_request_allowed(period_id, class_id, child_id)
  );

drop policy if exists enrollment_requests_admin_write on public.enrollment_requests;
create policy enrollment_requests_admin_write on public.enrollment_requests
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

grant select on public.enrollment_periods, public.enrollment_requests to authenticated;
grant insert, update, delete on public.enrollment_periods, public.enrollment_requests to authenticated;

-- --- keep the gate in step with grades[] -----------------------------------
-- enrollment_request_allowed matched a child's grade against classes.age_band.
-- That column is being retired, so the check moves to grades[]: a class with no
-- grades listed accepts anyone, otherwise the child's grade must be in the list.
-- Everything else about the function -- the open window, family access, and the
-- block double-booking guards -- is left exactly as it was.
create or replace function private.enrollment_request_allowed(wanted_period_id uuid, wanted_class_id uuid, wanted_child_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
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
      and (cardinality(cl.grades) = 0 or ch.age_band is null or ch.age_band = any (cl.grades))
      and not exists (
        select 1 from public.enrollment_requests er
        join public.classes other_class on other_class.id = er.class_id
        where er.period_id = wanted_period_id
          and er.child_id = wanted_child_id
          and er.status in ('requested','approved','waitlisted')
          and other_class.block_label is not distinct from cl.block_label
          and er.class_id <> wanted_class_id
      )
      and not exists (
        select 1 from public.enrollments e
        join public.classes other_class on other_class.id = e.class_id
        where e.child_id = wanted_child_id and e.status = 'active'
          and other_class.block_label is not distinct from cl.block_label
          and e.class_id <> wanted_class_id
      )
  );
$function$;

-- Now that nothing reads it, the free-text column goes. children.age_band stays
-- -- that is the child's own grade, which grades[] matches against.
alter table public.classes drop column if exists age_band;
