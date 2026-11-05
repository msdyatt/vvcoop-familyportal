-- The final administrator role cannot be deleted. This guard has been live in
-- production for a while but was created by hand and is in no migration, so a
-- database rebuilt from the migrations alone would silently lack it. Found by
-- replaying the full history into an empty database and comparing it with
-- production. The definitions below are production's, verbatim; applying this
-- there changes nothing.
create or replace function private.prevent_last_admin_removal()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if old.role = 'admin' and not exists (
    select 1 from public.user_roles
    where role = 'admin' and user_id <> old.user_id
  ) then
    raise exception 'The final administrator role cannot be removed.';
  end if;
  return old;
end;
$function$;

drop trigger if exists protect_last_admin on public.user_roles;
create trigger protect_last_admin
  before delete on public.user_roles
  for each row execute function private.prevent_last_admin_removal();
