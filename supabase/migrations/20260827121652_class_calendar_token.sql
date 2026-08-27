-- QA finding VV-08: ?scope=class&id=<classId> served a calendar feed to
-- anyone who had the class's id, no other check at all -- a uuid is
-- unguessable, but knowing it is not the same as being authorized, and
-- there was no way to revoke access short of deleting the class. Brings this
-- feed in line with the personal one (?scope=personal&token=...), which
-- already works this way.
--
-- The feed itself stays low-stakes by design (meeting day/time/room, never
-- who's enrolled -- see calendar-feed/index.ts's own comment), so this adds
-- a real, revocable credential rather than restructuring the feed into a
-- full per-family authenticated export.
alter table public.classes add column if not exists calendar_token uuid not null default gen_random_uuid();
create unique index if not exists classes_calendar_token_idx on public.classes(calendar_token);

comment on column public.classes.calendar_token is
  'Opaque token gating this class''s subscribable calendar feed (supabase/functions/calendar-feed, scope=class). Not meant to be set directly by clients -- see regenerate_class_calendar_token(). A leaked link is invalidated by regenerating.';

create or replace function public.regenerate_class_calendar_token(p_class_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  new_token uuid := gen_random_uuid();
begin
  if not private.has_role('admin') then
    raise exception 'Administrator access is required.';
  end if;
  update public.classes set calendar_token = new_token where id = p_class_id;
  if not found then
    raise exception 'That class could not be found.';
  end if;
  return new_token;
end;
$$;
revoke all on function public.regenerate_class_calendar_token(uuid) from public;
grant execute on function public.regenerate_class_calendar_token(uuid) to authenticated;

-- Admins can already read every class column via the existing classes_read/
-- classes_admin_write policies; calendar_token rides along with the same
-- select grant classes already has, no separate policy needed. UPDATE is
-- already admin-gated at the row-policy level, so a non-admin can't reach
-- this column regardless -- but `classes` also carries a blanket table-level
-- UPDATE grant to `authenticated` (the same "narrower column revoke doesn't
-- shrink a broader table grant" trap already hit on profiles), so an admin's
-- own class-edit save could still silently overwrite calendar_token if it
-- were ever accidentally included in a future payload. Restricting the grant
-- explicitly closes that off now rather than relying on today's save
-- payload happening to omit it.
revoke update on public.classes from authenticated;
grant update (title, description, term, grades, block_id, room_id, active, is_elective, school_year_id)
  on public.classes to authenticated;
