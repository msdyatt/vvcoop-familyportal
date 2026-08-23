-- Time blocks and rooms for classes.
--
-- Before this, `classes.block_label` and `classes.meeting_time` were both free
-- text: one class read "9" and the rest were empty. Two problems fell out of
-- that, and this migration fixes both.
--
-- 1. A block that is only a label cannot tell anyone what time a class starts.
--    Blocks are now real rows with a start and end time, defined once per school
--    year, and a class points at one. The time on a class is therefore always
--    the time of its block -- they cannot drift apart, because there is only one
--    of them.
--
-- 2. `private.enrollment_request_allowed` treated two classes as clashing when
--    `block_label is not distinct from` each other. Every label was NULL, and
--    NULL is not distinct from NULL, so *every* class collided with every other
--    one: a child could hold exactly one class, co-op wide. Rewritten below to
--    compare block ids and to treat "no block set" as "no known clash".

create table if not exists public.class_blocks (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid references public.school_years(id) on delete cascade,
  label text not null,
  starts_at time not null,
  ends_at time not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  constraint class_blocks_end_after_start check (ends_at > starts_at)
);

create index if not exists class_blocks_year_idx on public.class_blocks (school_year_id, sort_order);

-- Rooms are a managed list rather than free text so the same room is spelled the
-- same way everywhere -- which is what makes it possible to notice two classes
-- booked into one room at one time.
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  note text,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.classes
  add column if not exists block_id uuid references public.class_blocks(id) on delete set null,
  add column if not exists room_id  uuid references public.rooms(id)        on delete set null;

create index if not exists classes_block_idx on public.classes (block_id);
create index if not exists classes_room_idx  on public.classes (room_id);

alter table public.class_blocks enable row level security;
alter table public.rooms        enable row level security;

-- Everyone signed in reads the timetable; only administrators change it. Same
-- shape as the other reference tables in this schema.
drop policy if exists class_blocks_read on public.class_blocks;
create policy class_blocks_read on public.class_blocks
  for select to authenticated using (private.is_active_user());

drop policy if exists class_blocks_admin on public.class_blocks;
create policy class_blocks_admin on public.class_blocks
  for all to authenticated using (private.has_role('admin')) with check (private.has_role('admin'));

drop policy if exists rooms_read on public.rooms;
create policy rooms_read on public.rooms
  for select to authenticated using (private.is_active_user());

drop policy if exists rooms_admin on public.rooms;
create policy rooms_admin on public.rooms
  for all to authenticated using (private.has_role('admin')) with check (private.has_role('admin'));

-- Clash detection, corrected. Two classes clash only when both sit in the same
-- named block; a class with no block set is not assumed to clash with anything,
-- because "unknown" is not the same as "the same time".
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
      )
      and not exists (
        select 1 from public.enrollments e
        join public.classes other_class on other_class.id = e.class_id
        where e.child_id = wanted_child_id and e.status = 'active'
          and cl.block_id is not null
          and other_class.block_id = cl.block_id
          and e.class_id <> wanted_class_id
      )
  );
$function$;
