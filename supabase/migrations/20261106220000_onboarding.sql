-- Where each person is in the first-run tour. The app shows the tour when this
-- is behind the current version, so a new version of the tour (say, after a new
-- feature) is shown once to everyone without a new migration per change.
alter table public.profiles add column if not exists onboarding_version integer not null default 0;

-- Writes go through a function: profiles only allows a person to edit a few
-- named columns directly, and this should never move backwards.
create or replace function public.complete_onboarding(p_version integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;
  update public.profiles
  set onboarding_version = greatest(onboarding_version, least(coalesce(p_version, 0), 1000))
  where id = (select auth.uid());
end;
$function$;

revoke all on function public.complete_onboarding(integer) from public, anon;
grant execute on function public.complete_onboarding(integer) to authenticated;
