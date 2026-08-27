-- QA finding VV-05: the UI challenges a user for their second factor
-- (mfa-challenge.tsx, checked in portal-gate.tsx) when their session hasn't
-- reached aal2, but that check only ever ran in the browser. Nothing at the
-- database layer inspected the JWT's aal claim, so a valid-but-lower-
-- assurance session (a real, signed-in JWT that just hasn't stepped up yet)
-- could reach every table directly and skip the UI gate entirely.
--
-- Zero accounts currently have a verified MFA factor enrolled (checked
-- before writing this), so this is a genuine no-op for every existing user
-- today -- aal_satisfied() below returns true unconditionally for anyone
-- with no verified factor. It only starts mattering the moment someone
-- actually enrolls one, which is exactly when it should.
create or replace function private.aal_satisfied()
returns boolean
language sql stable security definer set search_path to ''
as $$
  select
    not exists (
      select 1 from auth.mfa_factors
      where user_id = auth.uid() and status = 'verified'
    )
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;
revoke all on function private.aal_satisfied() from public, anon;
grant execute on function private.aal_satisfied() to authenticated;

-- Applied to every RLS-enabled table in one pass rather than by hand per
-- table -- with 35 tables today, a hand-written list is exactly the kind of
-- thing a future table addition quietly falls outside of, which is the same
-- class of gap this fix exists to close in the first place.
--
-- A RESTRICTIVE policy is AND'ed with every permissive policy already on the
-- table rather than replacing them, and only applies to the authenticated
-- role -- anon access (public news, public calendar feeds) is untouched.
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and rowsecurity
  loop
    execute format(
      'drop policy if exists aal2_required on public.%I;', t.tablename
    );
    execute format(
      'create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied());',
      t.tablename
    );
  end loop;
end $$;
