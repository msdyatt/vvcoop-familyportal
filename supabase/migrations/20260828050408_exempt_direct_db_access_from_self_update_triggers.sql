-- Third trust boundary these triggers didn't recognize: a raw database
-- session (Supabase SQL Editor, psql, a migration) carries no PostgREST JWT
-- context at all -- auth.role()/auth.uid() are both null, not 'service_role'
-- and not an authenticated admin -- so neither of the two exemptions added in
-- 20260828023602 covered it. Confirmed live: attempting to restore an
-- accidentally self-removed admin account via the SQL Editor hit this exact
-- wall (28 Aug 2026).
--
-- Exempting `auth.role() is null` is safe: PostgREST always sets a role claim
-- for every API request it handles, even 'anon' -- so a null role can only
-- mean this connection isn't coming through the public API surface at all.
-- Reaching this path requires actual Postgres credentials or dashboard
-- access, at which point this trigger provides no real protection anyway
-- (that access could drop the trigger, disable RLS, or edit the row through
-- twenty other paths) -- it would only be adding friction to legitimate
-- database administration, not stopping anything.
create or replace function private.restrict_profile_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') or auth.role() = 'service_role' or auth.role() is null then return new; end if;

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
  if private.has_role('admin') or auth.role() = 'service_role' or auth.role() is null then return new; end if;

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
