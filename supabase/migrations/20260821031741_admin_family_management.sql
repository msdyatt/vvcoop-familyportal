-- Family/child management, user + child removal, and upload support for
-- news, teacher handouts, and print requests.

-- ---------------------------------------------------------------------------
-- 1. `last_name` was added to families/children by hand at some point and was
--    never captured in a migration. Re-declare it here (no-op if present) so
--    the migration history matches the live schema going forward.
-- ---------------------------------------------------------------------------
alter table public.families add column if not exists last_name text;
alter table public.children add column if not exists last_name text;

-- A child can be flagged to keep a different last name than the family
-- record (blended families, guardians, etc). Sync skips overridden children.
alter table public.children add column if not exists last_name_override boolean not null default false;

create or replace function private.sync_children_last_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.last_name is distinct from old.last_name then
    update public.children
    set last_name = new.last_name, updated_at = now()
    where family_id = new.id and last_name_override = false;
  end if;
  return new;
end;
$$;
revoke all on function private.sync_children_last_name() from public, anon, authenticated;

drop trigger if exists on_family_last_name_change on public.families;
create trigger on_family_last_name_change
after update of last_name on public.families
for each row execute function private.sync_children_last_name();

-- New children default to the family's current last name unless one is given.
create or replace function private.default_child_last_name()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.last_name is null then
    select f.last_name into new.last_name from public.families f where f.id = new.family_id;
  end if;
  return new;
end;
$$;
revoke all on function private.default_child_last_name() from public, anon, authenticated;

drop trigger if exists on_child_insert_default_last_name on public.children;
create trigger on_child_insert_default_last_name
before insert on public.children
for each row execute function private.default_child_last_name();

-- ---------------------------------------------------------------------------
-- 2. A 'removed' account status so admins can revoke access without
--    hard-deleting a profile that's referenced by posts, notes, media, etc.
-- ---------------------------------------------------------------------------
alter type public.account_status add value if not exists 'removed';

-- ---------------------------------------------------------------------------
-- 3. Admin write access: edit family/child records, remove a user's roles
--    and household membership, and reactivate/deactivate children.
-- ---------------------------------------------------------------------------
create policy families_admin_write on public.families for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant update (display_name, last_name) on public.families to authenticated;

create policy children_admin_write on public.children for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant update (first_name, last_name, last_initial, age_band, active, last_name_override) on public.children to authenticated;

create policy profiles_admin_write on public.profiles for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant update (status) on public.profiles to authenticated;

create policy user_roles_admin_write on public.user_roles for delete to authenticated
  using (private.has_role('admin'));
grant delete on public.user_roles to authenticated;

create policy family_members_admin_write on public.family_members for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant insert, delete on public.family_members to authenticated;

create policy audit_admin_insert on public.audit_log for insert to authenticated
  with check (private.has_role('admin'));
grant insert on public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- 4. News posts: allow an uploaded image, not just an external link.
-- ---------------------------------------------------------------------------
alter table public.posts add column if not exists image_storage_path text;
grant insert, update, delete on public.posts to authenticated;
drop policy if exists posts_admin_write on public.posts;
create policy posts_admin_write on public.posts for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin') and author_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. Teacher handouts: documents can now be scoped to a class, not just a
--    family/child, so a teacher can post a class-wide file.
-- ---------------------------------------------------------------------------
alter table public.documents add column if not exists class_id uuid references public.classes(id) on delete cascade;
alter table public.documents add column if not exists uploaded_by_user_id uuid references public.profiles(id);

drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated using (
  private.has_role('admin')
  or (family_id is not null and private.has_family_access(family_id))
  or (class_id is not null and (private.teaches_class(class_id) or private.has_class_family_access(class_id)))
);

create policy documents_teacher_write on public.documents for insert to authenticated with check (
  uploaded_by_user_id = (select auth.uid())
  and (private.has_role('admin') or (class_id is not null and private.teaches_class(class_id)))
);
create policy documents_author_delete on public.documents for delete to authenticated using (
  private.has_role('admin') or uploaded_by_user_id = (select auth.uid())
);
grant insert, delete on public.documents to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Teachers' Lounge print requests.
-- ---------------------------------------------------------------------------
create table if not exists public.print_requests (
  id uuid primary key default gen_random_uuid(),
  class_id uuid references public.classes(id) on delete set null,
  requested_by_user_id uuid not null references public.profiles(id),
  title text not null,
  storage_path text not null,
  quantity integer not null default 1 check (quantity > 0),
  status text not null default 'pending' check (status in ('pending', 'printed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists print_requests_status_idx on public.print_requests(status, created_at);
alter table public.print_requests enable row level security;

create policy print_requests_read on public.print_requests for select to authenticated using (
  private.has_role('admin') or requested_by_user_id = (select auth.uid())
);
create policy print_requests_insert on public.print_requests for insert to authenticated with check (
  requested_by_user_id = (select auth.uid()) and private.is_active_user()
);
create policy print_requests_update on public.print_requests for update to authenticated using (
  private.has_role('admin') or requested_by_user_id = (select auth.uid())
) with check (
  private.has_role('admin') or requested_by_user_id = (select auth.uid())
);
grant select, insert, update on public.print_requests to authenticated;
