-- A family cannot read another household's enrolments (enrollments_read is
-- family-scoped), so the class picker in child-detail has no way to tell on its
-- own whether an elective is full or which prerequisites a child is missing.
-- This SECURITY DEFINER helper answers exactly that, for one child and a given
-- set of classes, without exposing any other family's roster.
--
-- It returns a row per requested class id: is_full (capacity reached) and
-- missing_prerequisites (titles of required classes the child is not actively
-- enrolled in). An enrollable class comes back with is_full = false and an
-- empty array. Same "active enrolment satisfies a prerequisite" rule as
-- private.child_meets_prerequisites.
create or replace function public.family_enrollment_options(p_child_id uuid, p_class_ids uuid[])
returns table (class_id uuid, is_full boolean, missing_prerequisites text[])
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not private.has_child_family_access(p_child_id) then
    raise exception 'You do not have access to this child.';
  end if;

  return query
  select
    cl.id,
    not private.class_has_capacity(cl.id) as is_full,
    coalesce((
      select array_agg(pre.title order by pre.title)
      from public.class_prerequisites cp
      join public.classes pre on pre.id = cp.prerequisite_class_id
      where cp.class_id = cl.id
        and not exists (
          select 1 from public.enrollments e
          where e.child_id = p_child_id
            and e.class_id = cp.prerequisite_class_id
            and e.status = 'active'
        )
    ), '{}'::text[]) as missing_prerequisites
  from public.classes cl
  where cl.id = any (p_class_ids);
end;
$function$;

revoke all on function public.family_enrollment_options(uuid, uuid[]) from public;
grant execute on function public.family_enrollment_options(uuid, uuid[]) to authenticated;
