-- Regression from VV-04 (restrict_profile_self_update.sql): the trigger's
-- only exemption is `private.has_role('admin')`, which resolves via
-- `auth.uid()` -- there is no such thing for a service-role connection (the
-- edge functions' own adminClient), so it evaluates false and the trigger
-- applies its self-service restrictions to legitimate backend writes too.
--
-- This silently broke invite-family-admin: onboarding a newly invited user
-- sets their fresh profile's status from 'pending' to 'active' via the
-- service-role client, which the trigger's "never reactivated" rule blocked
-- outright (`private.has_role('admin')` false -> falls through to the status
-- check -> raises). The function's own try/catch turned that into a bare
-- 500 *before ever reaching the email send*, so no invitation email, no
-- email_outbox row, and no error_log entry either -- confirmed live via
-- query_logs (postgres_logs: "An account can only be set to removed, never
-- reactivated, from self-service." at the exact moment of a real failed
-- invite, 28 Aug 2026).
--
-- private.restrict_family_child_update() (family_child_self_service.sql)
-- has the identical gap -- same has_role('admin')-only exemption, same
-- family_id/active/name restrictions a service-role admin write could
-- legitimately need to touch. Nothing currently updates children via a
-- service-role client (checked: no edge function does), so it hasn't fired
-- yet, but it's the same defect and gets the same fix here rather than
-- waiting to rediscover it the same way.
--
-- auth.role() reads the request's JWT `role` claim -- 'service_role' for any
-- client constructed with SUPABASE_SERVICE_ROLE_KEY, which is exactly (and
-- only) how these edge functions' backend writes authenticate.
create or replace function private.restrict_profile_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') or auth.role() = 'service_role' then return new; end if;

  if new.id is distinct from old.id
    or new.email is distinct from old.email
    or new.calendar_token is distinct from old.calendar_token
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

create or replace function private.restrict_family_child_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') or auth.role() = 'service_role' then return new; end if;

  if new.first_name is distinct from old.first_name
    or new.last_name is distinct from old.last_name
    or new.last_initial is distinct from old.last_initial
    or new.last_name_override is distinct from old.last_name_override
    or new.active is distinct from old.active
    or new.family_id is distinct from old.family_id
  then
    raise exception 'Families may update a child''s photo, birthdate, and grade only.';
  end if;

  return new;
end;
$$;
