-- QA finding VV-04 (critical): profiles_self_update's WITH CHECK is only
-- `id = auth.uid()` -- no column restriction at all. Postgres RLS OR's every
-- applicable permissive policy together for the same command, so this one
-- policy alone was enough to let a signed-in user set their OWN status to
-- 'active' directly (confirmed in a rolled-back transaction by the reviewer),
-- completely undermining the separate, narrowly-scoped profiles_self_delete
-- policy (which correctly only allows status -> 'removed'). The same gap
-- also let a client self-write email, calendar_token (documented as "not
-- meant to be set directly by clients -- see regenerate_calendar_token()"),
-- and id.
--
-- Same fix shape as private.restrict_family_child_update() (see
-- family_child_self_service.sql): a BEFORE UPDATE trigger that runs
-- regardless of which RLS policy admitted the row, so it closes the gap
-- everywhere at once rather than needing every self-service policy on this
-- table to individually stay perfectly scoped forever.
create or replace function private.restrict_profile_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') then return new; end if;

  -- id/email/calendar_token/created_at are never self-editable: id and
  -- created_at for the obvious reason, email because nothing in the app
  -- offers a self-service email change (it would need to go through Supabase
  -- Auth's own verified-email-change flow, not a plain profile edit), and
  -- calendar_token because it exists specifically so a leaked feed link can
  -- be invalidated by regenerate_calendar_token() -- a client that could set
  -- it directly could un-invalidate its own leak.
  if new.id is distinct from old.id
    or new.email is distinct from old.email
    or new.calendar_token is distinct from old.calendar_token
    or new.created_at is distinct from old.created_at
  then
    raise exception 'That field cannot be changed here.';
  end if;

  -- The one status transition self-service is allowed to make.
  if new.status is distinct from old.status and new.status is distinct from 'removed' then
    raise exception 'An account can only be set to removed, never reactivated, from self-service.';
  end if;

  return new;
end;
$$;
revoke all on function private.restrict_profile_self_update() from public, anon, authenticated;

drop trigger if exists profiles_self_update_guard on public.profiles;
create trigger profiles_self_update_guard
  before update on public.profiles
  for each row execute function private.restrict_profile_self_update();
