-- Correction to 20260827070000_restrict_profile_self_update.sql: putting
-- calendar_token in that trigger's blanket forbidden-column list also blocked
-- the ONE legitimate way it's meant to change -- a non-admin's own call to
-- regenerate_calendar_token() -- since the trigger fires on the actual row
-- update regardless of which SECURITY DEFINER function issued it. Verified
-- broken in a rolled-back transaction (a real non-admin profile's own
-- regenerate_calendar_token() call raised "That field cannot be changed
-- here.") before writing this fix.
--
-- The column-grant revoke below is what should have guarded calendar_token
-- in the first place, matching how this project already gates most
-- self-service columns: it blocks a direct client PATCH from touching the
-- column at all, while regenerate_calendar_token() is unaffected because a
-- SECURITY DEFINER function runs with its owner's privileges, not the
-- caller's -- a grant revoked from `authenticated` never applies to it.
create or replace function private.restrict_profile_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') then return new; end if;

  if new.id is distinct from old.id
    or new.email is distinct from old.email
    or new.created_at is distinct from old.created_at
  then
    raise exception 'That field cannot be changed here.';
  end if;

  if new.status is distinct from old.status and new.status is distinct from 'removed' then
    raise exception 'An account can only be set to removed, never reactivated, from self-service.';
  end if;

  return new;
end;
$$;

revoke update (calendar_token) on public.profiles from authenticated;
