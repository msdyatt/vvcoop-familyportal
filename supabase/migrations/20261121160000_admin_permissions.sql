-- Admin permissions: two admin tiers and five board-only permissions.
--
-- Until now every administrator could do everything. The board wants day-to-day
-- admins (families, classes, messages, calendar and so on) kept away from five
-- areas unless the board grants them:
--
--   integrations        Stripe mode, the office inbox connection and Google setup, outside-service
--                       settings, reviewer (demo) accounts
--   year_setup          start the next school year, school years, terms, enrollment windows,
--                       which families return
--   dues_settings       dues amounts, payment plan options, discount types, billing and
--                       receipt settings
--   tax_compliance      records vault, compliance calendar, year-end tax summary
--   manage_permissions  who is an admin, their tier, and these switches
--
-- The admin role itself (user_roles 'admin') stays as it was. On top of it:
--   public.admin_tiers                 'board' or 'admin'; no row means 'admin' (the day-to-day tier)
--   public.admin_permission_overrides  per-person grant (true) or revoke (false) on top of the tier
--   public.admin_permission_audit      append-only log of every change
--
-- Board admins get all five by default; admins get none. Every existing admin is
-- seeded as a board admin, so nobody loses access when this deploys.
--
-- Enforcement is in the database: the functions behind each area call
-- private.require_admin_permission(), and restrictive RLS policies stop direct table
-- writes (and, for the records areas, reads). Restrictive policies are used on purpose:
-- some of these tables also carry older permissive policies that were made by hand, and
-- a restrictive policy is AND'ed with all of them.
--
-- Lockout guard: at least one active board admin must always hold manage_permissions.
-- Any change that would leave none (a tier change, a revoke, removing the admin role,
-- deactivating or deleting the account, including doing it to yourself) is refused.

-- --- the catalog ----------------------------------------------------------------------------
create or replace function private.admin_permission_catalog()
returns table (key text, label text, description text, board_default boolean, admin_default boolean, sort_order integer)
language sql immutable set search_path to ''
as $function$
  values
    ('integrations', 'Integrations', 'Stripe mode, the office inbox connection, outside-service settings and reviewer accounts.', true, false, 1),
    ('year_setup', 'School year setup', 'Start the next school year, school years, terms, enrollment windows and which families return.', true, false, 2),
    ('dues_settings', 'Dues and fees', 'Dues amounts, payment plan options, discount types, and billing and receipt settings.', true, false, 3),
    ('tax_compliance', 'Tax and compliance records', 'The records vault, the compliance calendar and the year-end tax summary.', true, false, 4),
    ('manage_permissions', 'Admin permissions', 'Who is an admin, their tier, and these permissions.', true, false, 5)
$function$;
revoke all on function private.admin_permission_catalog() from public, anon, authenticated;

-- --- tables ---------------------------------------------------------------------------------
create table public.admin_tiers (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tier text not null check (tier in ('board', 'admin')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.admin_permission_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null check (permission in ('integrations', 'year_setup', 'dues_settings', 'tax_compliance', 'manage_permissions')),
  granted boolean not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, permission)
);

-- No foreign keys: the log outlives the accounts it mentions, and an erased account's
-- name is not copied here (it is looked up when the log is read).
create table public.admin_permission_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  subject_user_id uuid not null,
  action text not null check (action in ('seeded', 'admin_added', 'admin_removed', 'tier_changed', 'permission_granted', 'permission_revoked', 'permission_default')),
  permission text,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index admin_permission_audit_created_idx on public.admin_permission_audit (created_at desc);

create or replace function private.admin_permission_audit_append_only()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  raise exception 'The admin permission log is never edited or deleted.' using errcode = '23000';
end;
$function$;
revoke all on function private.admin_permission_audit_append_only() from public, anon, authenticated;
create trigger admin_permission_audit_append_only before update or delete on public.admin_permission_audit
  for each row execute function private.admin_permission_audit_append_only();

-- --- who has what ---------------------------------------------------------------------------
-- An active, non-demo account with the admin role. Takes a user id so the service-role
-- functions (Edge Functions acting for a person) can ask about that person.
create or replace function private.is_admin_user(p_user uuid)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    join public.user_roles r on r.user_id = p.id and r.role = 'admin'
    where p.id = p_user and p.status = 'active' and not coalesce(p.is_demo, false));
$function$;

-- 'board', 'admin', or null when the person is not an admin.
create or replace function private.admin_tier_of(p_user uuid)
returns text language sql stable security definer set search_path to ''
as $function$
  select case when private.is_admin_user(p_user)
    then coalesce((select t.tier from public.admin_tiers t where t.user_id = p_user), 'admin') end;
$function$;

create or replace function private.admin_permission_for(p_user uuid, p_permission text)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select coalesce((
    select coalesce(o.granted, case private.admin_tier_of(p_user) when 'board' then c.board_default else c.admin_default end)
    from private.admin_permission_catalog() c
    left join public.admin_permission_overrides o on o.user_id = p_user and o.permission = c.key
    where c.key = p_permission and private.admin_tier_of(p_user) is not null
  ), false);
$function$;

-- For RLS policies and checks made as the signed-in person.
create or replace function private.has_admin_permission(p_permission text)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select private.admin_permission_for((select auth.uid()), p_permission);
$function$;

create or replace function private.is_board_admin()
returns boolean language sql stable security definer set search_path to ''
as $function$
  select private.admin_tier_of((select auth.uid())) = 'board';
$function$;

-- The check every gated function starts with. Same messages and second-factor rule as
-- the existing require_*_admin helpers, plus the permission.
create or replace function private.require_admin_permission(p_permission text)
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.is_admin_user(v) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  if not private.admin_permission_for(v, p_permission) then
    raise exception 'Ask a board admin. This needs the "%" permission.',
      coalesce((select c.label from private.admin_permission_catalog() c where c.key = p_permission), p_permission)
      using errcode = '42501';
  end if;
  return v;
end;
$function$;

-- The same question for a person an Edge Function has already identified (service role only).
create or replace function public.admin_has_permission(p_user uuid, p_permission text)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select private.admin_permission_for(p_user, p_permission);
$function$;

-- Only the two that RLS policies call run as the signed-in person; the rest are called from
-- SECURITY DEFINER functions and triggers, so nobody else needs them.
revoke all on function private.is_admin_user(uuid), private.admin_tier_of(uuid),
  private.admin_permission_for(uuid, text), private.require_admin_permission(text) from public, anon, authenticated;
revoke all on function private.has_admin_permission(text), private.is_board_admin() from public, anon;
grant execute on function private.has_admin_permission(text), private.is_board_admin() to authenticated;
revoke all on function public.admin_has_permission(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_has_permission(uuid, text) to service_role;

-- --- lockout guard --------------------------------------------------------------------------
create or replace function private.is_permission_manager(p_user uuid)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select private.admin_tier_of(p_user) = 'board' and private.admin_permission_for(p_user, 'manage_permissions');
$function$;
revoke all on function private.is_permission_manager(uuid) from public, anon, authenticated;

-- Runs before the change, so "is this person a manager" reads the current state. Each
-- table says whether its change takes the person's standing away.
create or replace function private.guard_last_permission_manager()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare
  v_subject uuid;
  v_loses boolean := false;
begin
  if tg_table_name = 'user_roles' then
    v_subject := old.user_id;
    v_loses := old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin' or new.user_id <> old.user_id);
  elsif tg_table_name = 'profiles' then
    v_subject := old.id;
    v_loses := tg_op = 'DELETE' or (old.status = 'active' and new.status <> 'active')
      or (not coalesce(old.is_demo, false) and coalesce(new.is_demo, false));
  elsif tg_table_name = 'admin_tiers' then
    v_subject := old.user_id;
    v_loses := old.tier = 'board' and (tg_op = 'DELETE' or new.tier <> 'board' or new.user_id <> old.user_id);
  elsif tg_table_name = 'admin_permission_overrides' then
    if tg_op = 'INSERT' then
      v_subject := new.user_id;
      v_loses := new.permission = 'manage_permissions' and not new.granted;
    elsif tg_op = 'UPDATE' then
      v_subject := old.user_id;
      v_loses := (old.permission = 'manage_permissions' or new.permission = 'manage_permissions') and not new.granted;
    end if;
    -- Deleting an override returns the person to their tier default, which for a board
    -- admin is "granted", so it never takes manage_permissions away.
  end if;

  if v_loses and v_subject is not null then
    perform pg_advisory_xact_lock(hashtext('vv_admin_permission_managers'));
    if private.is_permission_manager(v_subject) and not exists (
      select 1 from public.profiles p
      where p.id <> v_subject and private.is_permission_manager(p.id)
    ) then
      raise exception 'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.'
        using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function private.guard_last_permission_manager() from public, anon, authenticated;

create trigger guard_last_permission_manager before update or delete on public.user_roles
  for each row execute function private.guard_last_permission_manager();
create trigger guard_last_permission_manager before update of status, is_demo or delete on public.profiles
  for each row execute function private.guard_last_permission_manager();
create trigger guard_last_permission_manager before update or delete on public.admin_tiers
  for each row execute function private.guard_last_permission_manager();
create trigger guard_last_permission_manager before insert or update on public.admin_permission_overrides
  for each row execute function private.guard_last_permission_manager();

-- --- the admin role itself ------------------------------------------------------------------
-- Adding or removing the admin role is "who has what", so it needs manage_permissions.
-- The permissive insert policy matches what the Families screen already does (granting
-- parent, teacher or admin); the restrictive ones close every admin-role change, whatever
-- other policies exist on the table.
drop policy if exists user_roles_admin_insert on public.user_roles;
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check (private.has_role('admin'));
drop policy if exists user_roles_admin_role_insert_gate on public.user_roles;
create policy user_roles_admin_role_insert_gate on public.user_roles as restrictive for insert to authenticated
  with check (role <> 'admin' or private.has_admin_permission('manage_permissions'));
drop policy if exists user_roles_admin_role_update_gate on public.user_roles;
create policy user_roles_admin_role_update_gate on public.user_roles as restrictive for update to authenticated
  using (role <> 'admin' or private.has_admin_permission('manage_permissions'))
  with check (role <> 'admin' or private.has_admin_permission('manage_permissions'));
drop policy if exists user_roles_admin_role_delete_gate on public.user_roles;
create policy user_roles_admin_role_delete_gate on public.user_roles as restrictive for delete to authenticated
  using (role <> 'admin' or private.has_admin_permission('manage_permissions'));

-- Log admin role changes, and clear tier and overrides when the role goes, so a person
-- made an admin again later starts from the day-to-day tier.
create or replace function private.log_admin_role_change()
returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' and new.role = 'admin' then
    insert into public.admin_permission_audit (actor_user_id, subject_user_id, action, new_value)
    values ((select auth.uid()), new.user_id, 'admin_added', coalesce((select t.tier from public.admin_tiers t where t.user_id = new.user_id), 'admin'));
  elsif tg_op = 'DELETE' and old.role = 'admin' then
    insert into public.admin_permission_audit (actor_user_id, subject_user_id, action, old_value)
    values ((select auth.uid()), old.user_id, 'admin_removed', coalesce((select t.tier from public.admin_tiers t where t.user_id = old.user_id), 'admin'));
    delete from public.admin_permission_overrides where user_id = old.user_id;
    delete from public.admin_tiers where user_id = old.user_id;
  end if;
  return null;
end;
$function$;
revoke all on function private.log_admin_role_change() from public, anon, authenticated;
create trigger log_admin_role_change after insert or delete on public.user_roles
  for each row execute function private.log_admin_role_change();

-- Deactivating or reactivating another admin's account takes away or gives back their
-- admin access, so a person doing it from the portal needs manage_permissions too.
-- Service-role and scheduled work (no signed-in person) is not affected.
create or replace function private.guard_admin_status_change()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := (select auth.uid());
begin
  if new.status is distinct from old.status and v_actor is not null and v_actor <> old.id
     and exists (select 1 from public.user_roles r where r.user_id = old.id and r.role = 'admin')
     and not private.admin_permission_for(v_actor, 'manage_permissions') then
    raise exception 'Ask a board admin. Changing an admin''s account needs the "Admin permissions" permission.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_admin_status_change() from public, anon, authenticated;
create trigger guard_admin_status_change before update of status on public.profiles
  for each row execute function private.guard_admin_status_change();

-- --- reading and changing permissions ---------------------------------------------------------
-- What the signed-in person may do. Used by the admin screens to hide controls; the
-- database checks again on every call.
create or replace function public.my_admin_access()
returns jsonb language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object(
    'is_admin', private.admin_tier_of((select auth.uid())) is not null,
    'tier', private.admin_tier_of((select auth.uid())),
    'permissions', coalesce((
      select jsonb_object_agg(c.key, private.admin_permission_for((select auth.uid()), c.key))
      from private.admin_permission_catalog() c), '{}'::jsonb));
$function$;

-- The Admin permissions screen: every admin with their tier and permissions, plus the
-- recent log. Board admins can see it; changing anything needs manage_permissions.
create or replace function public.admin_permissions_overview()
returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.is_admin_user(v) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  if private.admin_tier_of(v) <> 'board' and not private.admin_permission_for(v, 'manage_permissions') then
    raise exception 'Ask a board admin. Only board admins can see admin permissions.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_manage', private.admin_permission_for(v, 'manage_permissions'),
    'me', v,
    'catalog', (select jsonb_agg(jsonb_build_object('key', c.key, 'label', c.label, 'description', c.description,
                  'board_default', c.board_default, 'admin_default', c.admin_default) order by c.sort_order)
                from private.admin_permission_catalog() c),
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', p.id,
        'name', coalesce(nullif(btrim(p.display_name), ''), p.email),
        'email', p.email,
        'tier', private.admin_tier_of(p.id),
        'permissions', (select jsonb_object_agg(c.key, private.admin_permission_for(p.id, c.key)) from private.admin_permission_catalog() c),
        'overrides', coalesce((select jsonb_object_agg(o.permission, o.granted) from public.admin_permission_overrides o where o.user_id = p.id), '{}'::jsonb)
      ) order by (private.admin_tier_of(p.id) = 'board') desc, lower(coalesce(nullif(btrim(p.display_name), ''), p.email)))
      from public.profiles p
      where private.is_admin_user(p.id)), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'at', a.created_at, 'action', a.action, 'permission', a.permission,
        'old_value', a.old_value, 'new_value', a.new_value,
        'actor', coalesce(nullif(btrim(ap.display_name), ''), ap.email, case when a.actor_user_id is null then 'System' else 'Deleted account' end),
        'subject', coalesce(nullif(btrim(sp.display_name), ''), sp.email, 'Deleted account')
      ) order by a.id desc)
      from (select * from public.admin_permission_audit order by id desc limit 200) a
      left join public.profiles ap on ap.id = a.actor_user_id
      left join public.profiles sp on sp.id = a.subject_user_id), '[]'::jsonb));
end;
$function$;

create or replace function public.admin_set_admin_tier(p_user uuid, p_tier text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_admin_permission('manage_permissions');
  v_old text;
begin
  if p_tier is null or p_tier not in ('board', 'admin') then raise exception 'Choose board admin or admin.'; end if;
  v_old := private.admin_tier_of(p_user);
  if v_old is null then raise exception 'That person is not an admin.'; end if;
  if v_old = p_tier then return; end if;
  insert into public.admin_tiers (user_id, tier, updated_by) values (p_user, p_tier, v_actor)
  on conflict (user_id) do update set tier = excluded.tier, updated_by = excluded.updated_by, updated_at = now();
  insert into public.admin_permission_audit (actor_user_id, subject_user_id, action, old_value, new_value)
  values (v_actor, p_user, 'tier_changed', v_old, p_tier);
end;
$function$;

-- p_granted true or false sets the person's permission; a value equal to their tier's
-- default is stored as "no override", so it follows the tier from then on.
create or replace function public.admin_set_admin_permission(p_user uuid, p_permission text, p_granted boolean)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_admin_permission('manage_permissions');
  v_tier text := private.admin_tier_of(p_user);
  v_default boolean;
  v_old boolean;
begin
  if v_tier is null then raise exception 'That person is not an admin.'; end if;
  select case v_tier when 'board' then c.board_default else c.admin_default end into v_default
  from private.admin_permission_catalog() c where c.key = p_permission;
  if v_default is null then raise exception 'That is not an admin permission.'; end if;
  if p_granted is null then raise exception 'Choose on or off.'; end if;
  v_old := private.admin_permission_for(p_user, p_permission);
  if p_granted = v_default then
    delete from public.admin_permission_overrides where user_id = p_user and permission = p_permission;
  else
    insert into public.admin_permission_overrides (user_id, permission, granted, updated_by)
    values (p_user, p_permission, p_granted, v_actor)
    on conflict (user_id, permission) do update set granted = excluded.granted, updated_by = excluded.updated_by, updated_at = now();
  end if;
  if v_old is distinct from p_granted then
    insert into public.admin_permission_audit (actor_user_id, subject_user_id, action, permission, old_value, new_value)
    values (v_actor, p_user,
      case when p_granted = v_default then 'permission_default' when p_granted then 'permission_granted' else 'permission_revoked' end,
      p_permission, v_old::text, p_granted::text);
  end if;
end;
$function$;

revoke all on function public.my_admin_access(), public.admin_permissions_overview(),
  public.admin_set_admin_tier(uuid, text), public.admin_set_admin_permission(uuid, text, boolean) from public, anon;
grant execute on function public.my_admin_access(), public.admin_permissions_overview(),
  public.admin_set_admin_tier(uuid, text), public.admin_set_admin_permission(uuid, text, boolean) to authenticated;

-- --- table access for the new tables --------------------------------------------------------
-- Reads go through the functions above; nothing is written from the browser directly.
alter table public.admin_tiers enable row level security;
alter table public.admin_permission_overrides enable row level security;
alter table public.admin_permission_audit enable row level security;
revoke all on public.admin_tiers, public.admin_permission_overrides, public.admin_permission_audit from public, anon, authenticated;
grant select on public.admin_tiers, public.admin_permission_overrides, public.admin_permission_audit to authenticated;
grant select, insert, update, delete on public.admin_tiers, public.admin_permission_overrides to service_role;
grant select, insert on public.admin_permission_audit to service_role;
create policy admin_tiers_read on public.admin_tiers for select to authenticated
  using (user_id = (select auth.uid()) or private.is_board_admin() or private.has_admin_permission('manage_permissions'));
create policy admin_permission_overrides_read on public.admin_permission_overrides for select to authenticated
  using (user_id = (select auth.uid()) or private.is_board_admin() or private.has_admin_permission('manage_permissions'));
create policy admin_permission_audit_read on public.admin_permission_audit for select to authenticated
  using (private.is_board_admin() or private.has_admin_permission('manage_permissions'));
do $$
declare t text;
begin
  foreach t in array array['admin_tiers', 'admin_permission_overrides', 'admin_permission_audit'] loop
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
    execute format('create policy no_demo_access on public.%I as restrictive for select to authenticated using (not private.is_demo_user())', t);
  end loop;
end $$;

-- ==============================================================================================
-- GATES
-- ==============================================================================================

-- --- tax_compliance: records vault, compliance calendar, tax summary ---------------------------
-- Every function in the three areas starts with require_records_admin().
create or replace function private.require_records_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
begin
  return private.require_admin_permission('tax_compliance');
end;
$function$;
revoke all on function private.require_records_admin() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['org_records', 'org_record_files', 'org_record_revisions', 'org_record_file_grants',
                           'org_facts', 'org_fact_revisions', 'tax_other_income', 'tax_year_inputs',
                           'compliance_settings', 'compliance_deadlines', 'compliance_deadline_reminder_log'] loop
    execute format('drop policy if exists board_permission_required on public.%I', t);
    execute format('create policy board_permission_required on public.%I as restrictive for all to authenticated using (private.has_admin_permission(''tax_compliance''))', t);
  end loop;
end $$;

drop policy if exists records_board_permission on storage.objects;
create policy records_board_permission on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'records/%' or private.has_admin_permission('tax_compliance'))
  with check (bucket_id <> 'family-village-private' or name not like 'records/%' or private.has_admin_permission('tax_compliance'));

-- --- year_setup: start next year, school years, terms, enrollment windows ----------------------
-- The rollover functions (preview, run, households, set returning) start with require_rollover_admin().
create or replace function private.require_rollover_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
begin
  return private.require_admin_permission('year_setup');
end;
$function$;
revoke all on function private.require_rollover_admin() from public, anon, authenticated;

-- Grade placement also used require_rollover_admin(), but placing children in classes is
-- day-to-day work, so it gets the old check under its own name.
create or replace function private.require_placement_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;
revoke all on function private.require_placement_admin() from public, anon, authenticated;

create or replace function public.admin_place_children_by_grade(p_year uuid, p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_placement_admin();
  v_result jsonb;
  v_detail text;
begin
  if p_year is null or not exists (select 1 from public.school_years where id = p_year) then
    raise exception 'That school year does not exist.' using errcode = 'P0001';
  end if;
  if coalesce(p_dry_run, false) then
    begin
      v_result := private.place_children_by_grade(p_year, v_actor);
      raise exception 'preview only' using errcode = 'VVDRY', detail = v_result::text;
    exception when sqlstate 'VVDRY' then
      get stacked diagnostics v_detail = pg_exception_detail;
      return v_detail::jsonb || jsonb_build_object('dry_run', true);
    end;
  end if;
  v_result := private.place_children_by_grade(p_year, v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'grade_placement_run', 'school_year', p_year::text, (v_result #- '{items}') - 'year_id');
  return v_result || jsonb_build_object('dry_run', false);
end;
$function$;
revoke all on function public.admin_place_children_by_grade(uuid, boolean) from public, anon;
grant execute on function public.admin_place_children_by_grade(uuid, boolean) to authenticated;

-- Direct writes from the Classes screen (school years, terms) and enrollment windows.
do $$
declare t text;
begin
  foreach t in array array['school_years', 'academic_terms', 'enrollment_periods'] loop
    execute format('drop policy if exists year_setup_insert_gate on public.%I', t);
    execute format('drop policy if exists year_setup_update_gate on public.%I', t);
    execute format('drop policy if exists year_setup_delete_gate on public.%I', t);
    execute format('create policy year_setup_insert_gate on public.%I as restrictive for insert to authenticated with check (private.has_admin_permission(''year_setup''))', t);
    execute format('create policy year_setup_update_gate on public.%I as restrictive for update to authenticated using (private.has_admin_permission(''year_setup'')) with check (private.has_admin_permission(''year_setup''))', t);
    execute format('create policy year_setup_delete_gate on public.%I as restrictive for delete to authenticated using (private.has_admin_permission(''year_setup''))', t);
  end loop;
end $$;

-- --- dues_settings: amounts, plan options, discount types, billing settings --------------------
-- Dues amounts are requirement rows of kind 'dues', written directly from the Dues screen.
-- The rollover copies them inside its own function, which year_setup already covers.
drop policy if exists dues_settings_insert_gate on public.requirements;
drop policy if exists dues_settings_update_gate on public.requirements;
drop policy if exists dues_settings_delete_gate on public.requirements;
create policy dues_settings_insert_gate on public.requirements as restrictive for insert to authenticated
  with check (kind <> 'dues' or private.has_admin_permission('dues_settings'));
create policy dues_settings_update_gate on public.requirements as restrictive for update to authenticated
  using (kind <> 'dues' or private.has_admin_permission('dues_settings'))
  with check (kind <> 'dues' or private.has_admin_permission('dues_settings'));
create policy dues_settings_delete_gate on public.requirements as restrictive for delete to authenticated
  using (kind <> 'dues' or private.has_admin_permission('dues_settings'));

create or replace function public.admin_set_dues_options(p_requirement uuid, p_monthly_enabled boolean, p_monthly_count integer, p_first_due_on date)
returns void language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.require_billing_admin();
  perform private.require_admin_permission('dues_settings');
  if not exists (select 1 from public.requirements where id = p_requirement and kind = 'dues') then
    raise exception 'That is not a dues requirement.';
  end if;
  insert into public.dues_requirement_options (requirement_id, monthly_enabled, monthly_count, monthly_first_due_on)
  values (p_requirement, p_monthly_enabled, coalesce(p_monthly_count, 9), p_first_due_on)
  on conflict (requirement_id) do update
    set monthly_enabled = excluded.monthly_enabled, monthly_count = excluded.monthly_count,
        monthly_first_due_on = excluded.monthly_first_due_on, updated_at = now();
  perform private.audit_billing('dues_options_set', 'requirement', p_requirement::text,
    jsonb_build_object('monthly_enabled', p_monthly_enabled, 'monthly_count', p_monthly_count));
end;
$function$;

create or replace function public.admin_update_billing_settings(
  p_reminder_days integer, p_retry_after_days integer, p_max_attempts integer,
  p_org_name text, p_ein text, p_address text, p_note text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_billing_admin();
begin
  perform private.require_admin_permission('dues_settings');
  update public.billing_settings
  set reminder_days_before = p_reminder_days, retry_after_days = p_retry_after_days, max_attempts = p_max_attempts,
      receipt_org_name = coalesce(nullif(trim(p_org_name), ''), 'Veritas Village'),
      receipt_ein = nullif(trim(coalesce(p_ein, '')), ''), receipt_address = nullif(trim(coalesce(p_address, '')), ''),
      receipt_note = nullif(trim(coalesce(p_note, '')), ''), updated_by = v_actor, updated_at = now()
  where id = 'dues';
  perform private.audit_billing('billing_settings_updated', 'billing_settings', 'dues', '{}'::jsonb);
end;
$function$;

create or replace function public.admin_create_discount_type(p_code text, p_label text, p_kind text, p_value integer)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid;
begin
  perform private.require_billing_admin();
  perform private.require_admin_permission('dues_settings');
  insert into public.dues_discount_types (code, label, kind, value) values (lower(trim(p_code)), trim(p_label), p_kind, p_value) returning id into v_id;
  perform private.audit_billing('dues_discount_type_created', 'dues_discount_type', v_id::text, jsonb_build_object('code', p_code));
  return v_id;
end;
$function$;

-- --- integrations: Stripe mode, office inbox connection, integration settings ------------------
create or replace function public.admin_set_billing_provider(p_provider text, p_approval uuid default null)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  v_old text := private.billing_provider();
begin
  perform private.require_admin_permission('integrations');
  if p_provider not in ('off', 'stripe_test', 'stripe_live') then raise exception 'Unknown mode.'; end if;
  if p_provider = 'stripe_live' then
    perform private.consume_approval(p_approval, 'enable_livemode', null, 0, v_actor);
  end if;
  update public.billing_settings
  set provider = p_provider, live_approval_id = case when p_provider = 'stripe_live' then p_approval else null end,
      updated_by = v_actor, updated_at = now()
  where id = 'dues';
  perform private.recompute_charge(id) from public.dues_charges;
  perform private.audit_billing('billing_provider_changed', 'billing_settings', 'dues', jsonb_build_object('from', v_old, 'to', p_provider, 'approval_id', p_approval));
end;
$function$;

create or replace function public.admin_purge_test_billing_data()
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_payments integer;
  v_customers integer;
  v_events integer;
begin
  perform private.require_billing_admin();
  perform private.require_admin_permission('integrations');
  if private.billing_provider() = 'stripe_live' then raise exception 'Switch back to test mode first.'; end if;
  perform set_config('vv.purge_test_billing', 'on', true);
  delete from public.dues_payments where not livemode and direction = 'refund';
  delete from public.dues_payments where not livemode;
  get diagnostics v_payments = row_count;
  delete from public.billing_customers where not livemode;
  get diagnostics v_customers = row_count;
  delete from public.stripe_webhook_events where not livemode;
  get diagnostics v_events = row_count;
  perform set_config('vv.purge_test_billing', 'off', true);
  perform private.recompute_charge(id) from public.dues_charges;
  perform private.audit_billing('billing_test_data_purged', 'billing_settings', 'dues',
    jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events));
  return jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events);
end;
$function$;

-- The office inbox connect and disconnect steps run as the service role for a person the
-- Edge Function has already checked; the database checks that person's permission too.
-- Reading and answering mail stays day-to-day (inbox_actor_ok).
create or replace function private.inbox_connect_ok(p_user uuid)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select private.inbox_actor_ok(p_user) and private.admin_permission_for(p_user, 'integrations');
$function$;
revoke all on function private.inbox_connect_ok(uuid) from public, anon, authenticated;

create or replace function public.office_inbox_begin_oauth(p_user uuid, p_state_hash text, p_code_verifier text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if not private.inbox_connect_ok(p_user) then raise exception 'Ask a board admin. This needs the "Integrations" permission.' using errcode = '42501'; end if;
  delete from public.office_inbox_oauth_states where expires_at < now() or user_id = p_user;
  insert into public.office_inbox_oauth_states (state_hash, user_id, code_verifier, expires_at)
  values (p_state_hash, p_user, p_code_verifier, now() + interval '10 minutes');
end;
$function$;

create or replace function public.office_inbox_take_oauth(p_state_hash text)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare r public.office_inbox_oauth_states;
begin
  delete from public.office_inbox_oauth_states where state_hash = p_state_hash returning * into r;
  if r.state_hash is null or r.expires_at < now() or not private.inbox_connect_ok(r.user_id) then return null; end if;
  return jsonb_build_object('user_id', r.user_id, 'code_verifier', r.code_verifier);
end;
$function$;

create or replace function public.office_inbox_save_connection(
  p_user uuid, p_address text, p_refresh_token text, p_label_id text, p_functions_url text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_secret uuid;
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if not private.inbox_connect_ok(p_user) then raise exception 'Ask a board admin. This needs the "Integrations" permission.' using errcode = '42501'; end if;
  if coalesce(p_refresh_token, '') = '' then raise exception 'Google did not return a refresh token.'; end if;
  select id into v_secret from vault.secrets where name = 'OFFICE_INBOX_REFRESH_TOKEN';
  if v_secret is null then
    perform vault.create_secret(p_refresh_token, 'OFFICE_INBOX_REFRESH_TOKEN', 'Office inbox: Google refresh token for the office mailbox');
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;
  update public.office_inbox_settings set
    status = 'connected', mailbox_address = lower(btrim(p_address)), gmail_label_id = p_label_id,
    functions_url = p_functions_url, connected_at = now(), connected_by = p_user,
    -- A different mailbox starts over from its own history.
    history_id = case when mailbox_address is not distinct from lower(btrim(p_address)) then history_id else null end,
    last_sync_error = null, sync_lease_until = null, updated_at = now()
  where id = 'office';
  perform private.inbox_log(null, p_user, 'connected', jsonb_build_object('mailbox', lower(btrim(p_address))));
end;
$function$;

create or replace function public.office_inbox_clear_connection(p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if not private.inbox_connect_ok(p_user) then raise exception 'Ask a board admin. This needs the "Integrations" permission.' using errcode = '42501'; end if;
  delete from vault.secrets where name = 'OFFICE_INBOX_REFRESH_TOKEN';
  update public.office_inbox_settings set status = 'disconnected', sync_lease_until = null, updated_at = now() where id = 'office';
  perform private.inbox_log(null, p_user, 'disconnected', jsonb_build_object('mailbox', (select mailbox_address from public.office_inbox_settings where id = 'office')));
end;
$function$;

revoke all on function public.office_inbox_begin_oauth(uuid, text, text), public.office_inbox_take_oauth(text),
  public.office_inbox_save_connection(uuid, text, text, text, text), public.office_inbox_clear_connection(uuid)
  from public, anon, authenticated;
grant execute on function public.office_inbox_begin_oauth(uuid, text, text), public.office_inbox_take_oauth(text),
  public.office_inbox_save_connection(uuid, text, text, text, text), public.office_inbox_clear_connection(uuid)
  to service_role;

-- The Google setup on the office inbox card (#159) stores the OAuth client secret in Vault.
-- Same function as 20261121150000_office_inbox_setup.sql, plus the permission check. Reading the
-- setup (office_inbox_setup, which never returns the secret) stays open to every admin.
create or replace function public.office_inbox_save_setup(
  p_client_id text, p_client_secret text, p_allowed_mailbox text, p_portal_site_url text, p_clear_secret boolean default false)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_inbox_admin();
  s public.office_inbox_settings;
  v_client_id text := nullif(btrim(coalesce(p_client_id, '')), '');
  v_secret text := nullif(btrim(coalesce(p_client_secret, '')), '');
  v_mailbox text := nullif(lower(btrim(coalesce(p_allowed_mailbox, ''))), '');
  v_site text := nullif(regexp_replace(btrim(coalesce(p_portal_site_url, '')), '/+$', ''), '');
  v_secret_id uuid;
  v_changed text[] := '{}';
begin
  perform private.require_admin_permission('integrations');
  select * into s from public.office_inbox_settings where id = 'office' for update;
  if v_client_id is not null and v_client_id !~ '^[A-Za-z0-9._-]{10,200}$' then
    raise exception 'That does not look like a Google client ID. Copy it from Google Cloud, Credentials.';
  end if;
  if v_secret is not null and (char_length(v_secret) < 10 or char_length(v_secret) > 200 or v_secret ~ '\s') then
    raise exception 'That does not look like a Google client secret. Copy it from Google Cloud, Credentials.';
  end if;
  if v_mailbox is not null and v_mailbox !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
    raise exception 'Enter the office mailbox as an email address, for example office@veritasvillage.org.';
  end if;
  if v_site is not null and v_site !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' and v_site !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$' then
    raise exception 'Enter the portal address as https:// and the host name only, for example https://family.veritasvillage.org.';
  end if;
  if s.status in ('connected', 'attention') and v_mailbox is distinct from s.allowed_mailbox
     and s.mailbox_address is not null and v_mailbox is distinct from s.mailbox_address then
    raise exception 'Disconnect the office inbox before changing which mailbox it reads.';
  end if;

  if v_client_id is distinct from s.google_client_id then v_changed := array_append(v_changed, 'client_id'); end if;
  if v_mailbox is distinct from s.allowed_mailbox then v_changed := array_append(v_changed, 'mailbox'); end if;
  if v_site is distinct from s.portal_site_url then v_changed := array_append(v_changed, 'portal_site_url'); end if;
  update public.office_inbox_settings
  set google_client_id = v_client_id, allowed_mailbox = v_mailbox, portal_site_url = v_site, updated_at = now()
  where id = 'office';

  select id into v_secret_id from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET';
  if v_secret is not null then
    if v_secret_id is null then
      perform vault.create_secret(v_secret, 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET', 'Office inbox: Google OAuth client secret');
    else
      perform vault.update_secret(v_secret_id, v_secret);
    end if;
    v_changed := array_append(v_changed, 'client_secret');
  elsif coalesce(p_clear_secret, false) and v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
    v_changed := array_append(v_changed, 'client_secret_removed');
  end if;

  if cardinality(v_changed) > 0 then
    perform private.inbox_log(null, v_me, 'setup_saved', jsonb_build_object('changed', to_jsonb(v_changed)));
  end if;
end;
$function$;
revoke all on function public.office_inbox_save_setup(text, text, text, text, boolean) from public, anon;
grant execute on function public.office_inbox_save_setup(text, text, text, text, boolean) to authenticated;

-- The Integrations screen saves rows of integration_settings directly (Resend From
-- address, printer, Facebook group link). The anonymous Facebook read is untouched.
drop policy if exists integrations_insert_gate on public.integration_settings;
drop policy if exists integrations_update_gate on public.integration_settings;
drop policy if exists integrations_delete_gate on public.integration_settings;
create policy integrations_insert_gate on public.integration_settings as restrictive for insert to authenticated
  with check (private.has_admin_permission('integrations'));
create policy integrations_update_gate on public.integration_settings as restrictive for update to authenticated
  using (private.has_admin_permission('integrations')) with check (private.has_admin_permission('integrations'));
create policy integrations_delete_gate on public.integration_settings as restrictive for delete to authenticated
  using (private.has_admin_permission('integrations'));

-- --- seed -------------------------------------------------------------------------------------
-- Every current admin becomes a board admin. The board decides who to move afterwards.
insert into public.admin_tiers (user_id, tier)
select distinct r.user_id, 'board' from public.user_roles r where r.role = 'admin'
on conflict (user_id) do nothing;
insert into public.admin_permission_audit (actor_user_id, subject_user_id, action, new_value)
select null, t.user_id, 'seeded', 'board' from public.admin_tiers t;
