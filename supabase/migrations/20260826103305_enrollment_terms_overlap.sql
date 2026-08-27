-- Two classes sharing a time block only actually clash if they can also run
-- at the same time of year. Since portal_schedule_terms, a class can be
-- scoped to one or more academic_terms (Fall Pottery, Wednesday Block C) --
-- but enrollment_request_allowed's same-block clash check never learned about
-- terms at all, so it falsely blocked enrollment in a same-block class that
-- actually runs in a different term (Spring Art, same Wednesday Block C), and
-- separately never stopped a family from being auto-enrolled in a class whose
-- term hasn't started yet.
--
-- A class with no term assigned is treated as year-round -- always a possible
-- clash -- matching the existing "empty grades array means any grade"
-- convention, so classes that predate this feature (or are deliberately
-- year-round) keep working exactly as before.
create or replace function private.classes_terms_overlap(class_a uuid, class_b uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select
    not exists (select 1 from public.class_terms where class_id = class_a)
    or not exists (select 1 from public.class_terms where class_id = class_b)
    or exists (
      select 1
      from public.class_terms cta
      join public.academic_terms ta on ta.id = cta.term_id
      join public.class_terms ctb on ctb.class_id = class_b
      join public.academic_terms tb on tb.id = ctb.term_id
      where cta.class_id = class_a
        and ta.starts_on <= tb.ends_on
        and tb.starts_on <= ta.ends_on
    );
$function$;

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
