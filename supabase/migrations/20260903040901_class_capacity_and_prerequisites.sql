-- Capacity and prerequisites for classes -- the two enrollment rules the co-op
-- had no way to state or enforce.
--
-- Until now a class could fill past its room's seats with nothing to stop it,
-- and a sequenced class (Latin II, Chemistry after Biology) had no way to say
-- it depends on another. Both checks belong where the existing eligibility
-- rules already live: private.enrollment_request_allowed, which
-- public.family_self_enroll re-runs at the moment a family enrols.
--
-- Choices, matching conventions already in this schema:
--   * classes.capacity NULL means "no limit" -- the same "empty means any"
--     idea as classes.grades and an unassigned class_terms.
--   * Capacity is enforced on the family self-enrol path only. An administrator
--     placing a child from Admin -> Classes can still exceed it deliberately
--     (a co-op does squeeze in a sibling), exactly as the room-clash check is a
--     warning and not a hard constraint. The admin card gets an "over
--     capacity" chip the same way it already shows a room clash.
--   * A prerequisite is satisfied by an *active* enrolment in the required
--     class. This project never moves a finished enrolment to a "completed"
--     state -- a class simply ends and the row stays 'active' -- so "is or has
--     been enrolled, and did not withdraw" is the honest test. 'withdrawn'
--     does not count.

-- --- capacity ---------------------------------------------------------------
alter table public.classes
  add column if not exists capacity integer
    constraint classes_capacity_nonnegative check (capacity is null or capacity >= 0);

comment on column public.classes.capacity is
  'Maximum active enrolments on the family self-enrol path. NULL means no limit. Administrators can still place children beyond this by hand.';

-- --- prerequisites --------------------------------------------------------
create table if not exists public.class_prerequisites (
  class_id uuid not null references public.classes(id) on delete cascade,
  prerequisite_class_id uuid not null references public.classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (class_id, prerequisite_class_id),
  constraint class_prerequisites_no_self check (class_id <> prerequisite_class_id)
);

create index if not exists class_prerequisites_prerequisite_idx
  on public.class_prerequisites (prerequisite_class_id, class_id);

comment on table public.class_prerequisites is
  'class_id requires a child to already hold an active enrolment in every prerequisite_class_id before the family can self-enrol. Administrators are not gated by this.';

alter table public.class_prerequisites enable row level security;

create policy class_prerequisites_read on public.class_prerequisites
  for select to authenticated
  using (private.is_active_user());

create policy class_prerequisites_admin on public.class_prerequisites
  for all to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

-- service_role comes free from 20260823041733_restore_service_role_grants.sql's
-- corrected default privileges; authenticated still needs the explicit grant.
grant select, insert, update, delete on public.class_prerequisites to authenticated;

-- --- helpers -------------------------------------------------------------
create or replace function private.class_active_enrollment_count(wanted_class_id uuid)
returns integer
language sql stable security definer set search_path to ''
as $function$
  select count(*)::integer
  from public.enrollments
  where class_id = wanted_class_id and status = 'active';
$function$;

create or replace function private.class_has_capacity(wanted_class_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select
    (select cl.capacity from public.classes cl where cl.id = wanted_class_id) is null
    or private.class_active_enrollment_count(wanted_class_id)
       < (select cl.capacity from public.classes cl where cl.id = wanted_class_id);
$function$;

create or replace function private.child_meets_prerequisites(wanted_class_id uuid, wanted_child_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select not exists (
    select 1
    from public.class_prerequisites cp
    where cp.class_id = wanted_class_id
      and not exists (
        select 1 from public.enrollments e
        where e.child_id = wanted_child_id
          and e.class_id = cp.prerequisite_class_id
          and e.status = 'active'
      )
  );
$function$;

-- --- fold both into the shared eligibility check --------------------------
-- Unchanged from 20260826103305_enrollment_terms_overlap.sql apart from the two
-- new AND clauses: capacity, then prerequisites.
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

-- --- specific messages on the self-enrol path ---------------------------
-- Same effect as before, but a family now hears "that class is full" or "needs
-- Biology first" instead of one catch-all sentence. A row lock on the class
-- serialises two families racing for the last seat so capacity can't be
-- overshot by concurrent self-enrols.
create or replace function public.family_self_enroll(p_period_id uuid, p_class_id uuid, p_child_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_missing text;
begin
  if not private.has_child_family_access(p_child_id) then
    raise exception 'You do not have access to this child.';
  end if;

  perform 1 from public.classes where id = p_class_id for update;

  if not private.class_has_capacity(p_class_id) then
    raise exception 'That class is full.';
  end if;

  if not private.child_meets_prerequisites(p_class_id, p_child_id) then
    select string_agg(pre.title, ', ' order by pre.title)
      into v_missing
    from public.class_prerequisites cp
    join public.classes pre on pre.id = cp.prerequisite_class_id
    where cp.class_id = p_class_id
      and not exists (
        select 1 from public.enrollments e
        where e.child_id = p_child_id
          and e.class_id = cp.prerequisite_class_id
          and e.status = 'active'
      );
    raise exception 'This class needs % first.', coalesce(v_missing, 'another class');
  end if;

  if not private.enrollment_request_allowed(p_period_id, p_class_id, p_child_id) then
    raise exception 'That class can''t be enrolled right now -- it may conflict with another class at the same time, or no longer match this child''s grade.';
  end if;

  insert into public.enrollment_requests (period_id, class_id, child_id, requested_by, status)
  values (p_period_id, p_class_id, p_child_id, (select auth.uid()), 'approved')
  on conflict (period_id, class_id, child_id) do update set status = 'approved';

  insert into public.enrollments (class_id, child_id, status)
  values (p_class_id, p_child_id, 'active')
  on conflict (class_id, child_id) do update set status = 'active';
end;
$function$;

revoke all on function public.family_self_enroll(uuid, uuid, uuid) from public;
grant execute on function public.family_self_enroll(uuid, uuid, uuid) to authenticated;
