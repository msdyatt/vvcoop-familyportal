create schema if not exists private;

create type public.account_status as enum ('pending', 'active', 'suspended');
create type public.village_role as enum ('parent', 'teacher', 'admin');
create type public.audience as enum ('public', 'families', 'teachers', 'class');
create type public.note_visibility as enum ('family', 'teachers', 'admins');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  status public.account_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_lower_idx on public.profiles (lower(email));

create table public.families (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  relationship text,
  created_at timestamptz not null default now(),
  primary key (family_id, user_id)
);
create index family_members_user_id_idx on public.family_members(user_id);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.village_role not null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.children (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  first_name text not null,
  last_initial text,
  age_band text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index children_family_id_idx on public.children(family_id);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  meeting_time text,
  term text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.enrollments (
  class_id uuid not null references public.classes(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'waitlisted', 'withdrawn')),
  created_at timestamptz not null default now(),
  primary key (class_id, child_id)
);
create index enrollments_child_id_idx on public.enrollments(child_id);
create table public.teacher_assignments (
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  assignment_role text not null check (assignment_role in ('lead', 'assistant')),
  created_at timestamptz not null default now(),
  primary key (class_id, user_id)
);
create index teacher_assignments_user_id_idx on public.teacher_assignments(user_id);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  title text not null,
  instructions text,
  due_at timestamptz,
  published_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assignments_class_due_idx on public.assignments(class_id, due_at);
create table public.teacher_notes (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  author_user_id uuid not null references public.profiles(id),
  body text not null,
  visibility public.note_visibility not null default 'family',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index teacher_notes_child_class_idx on public.teacher_notes(child_id, class_id);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_user_id uuid not null references public.profiles(id),
  title text not null,
  body text not null,
  audience public.audience not null,
  class_id uuid references public.classes(id) on delete cascade,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((audience = 'class' and class_id is not null) or audience <> 'class')
);
create index posts_audience_published_idx on public.posts(audience, published_at desc);
create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  audience public.audience not null,
  class_id uuid references public.classes(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((audience = 'class' and class_id is not null) or audience <> 'class')
);
create index events_starts_at_idx on public.events(starts_at);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references public.families(id) on delete cascade,
  child_id uuid references public.children(id) on delete cascade,
  kind text not null,
  title text not null,
  storage_path text,
  signature_provider text,
  provider_document_id text,
  signature_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_family_id_idx on public.documents(family_id);
create table public.media (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  title text,
  class_id uuid references public.classes(id) on delete set null,
  uploaded_by_user_id uuid not null references public.profiles(id),
  audience public.audience not null,
  created_at timestamptz not null default now()
);
create table public.media_consents (
  media_id uuid not null references public.media(id) on delete cascade,
  child_id uuid not null references public.children(id) on delete cascade,
  approved boolean not null default false,
  approved_by_user_id uuid references public.profiles(id),
  approved_at timestamptz,
  primary key (media_id, child_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  family_id uuid references public.families(id) on delete cascade,
  invited_by_user_id uuid not null references public.profiles(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_email_idx on public.invitations(lower(email));
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null references public.profiles(id),
  action text not null,
  subject_type text not null,
  subject_id text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on public.audit_log(created_at desc);

create or replace function private.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'active');
$$;
create or replace function private.has_role(wanted public.village_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r where r.user_id = (select auth.uid()) and r.role = wanted)
    and private.is_active_user();
$$;
create or replace function private.has_family_access(wanted_family_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members fm where fm.user_id = (select auth.uid()) and fm.family_id = wanted_family_id)
    and private.is_active_user();
$$;
create or replace function private.teaches_class(wanted_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.teacher_assignments ta where ta.user_id = (select auth.uid()) and ta.class_id = wanted_class_id)
    and private.is_active_user();
$$;
revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), null);
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.user_roles enable row level security;
alter table public.children enable row level security;
alter table public.classes enable row level security;
alter table public.enrollments enable row level security;
alter table public.teacher_assignments enable row level security;
alter table public.assignments enable row level security;
alter table public.teacher_notes enable row level security;
alter table public.posts enable row level security;
alter table public.events enable row level security;
alter table public.documents enable row level security;
alter table public.media enable row level security;
alter table public.media_consents enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (id = (select auth.uid()) or private.has_role('admin'));
create policy profiles_self_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy families_read on public.families for select to authenticated using (private.has_family_access(id) or private.has_role('admin'));
create policy family_members_read on public.family_members for select to authenticated using (user_id = (select auth.uid()) or private.has_family_access(family_id) or private.has_role('admin'));
create policy roles_read on public.user_roles for select to authenticated using (user_id = (select auth.uid()) or private.has_role('admin'));
create policy children_read on public.children for select to authenticated using (private.has_family_access(family_id) or private.has_role('admin') or exists (select 1 from public.enrollments e where e.child_id = children.id and private.teaches_class(e.class_id)));
create policy classes_read on public.classes for select to authenticated using (private.is_active_user());
create policy enrollments_read on public.enrollments for select to authenticated using (private.has_role('admin') or private.teaches_class(class_id) or exists (select 1 from public.children c where c.id = enrollments.child_id and private.has_family_access(c.family_id)));
create policy teacher_assignments_read on public.teacher_assignments for select to authenticated using (user_id = (select auth.uid()) or private.has_role('admin') or private.teaches_class(class_id) or exists (select 1 from public.enrollments e join public.children c on c.id = e.child_id where e.class_id = teacher_assignments.class_id and private.has_family_access(c.family_id)));
create policy assignments_read on public.assignments for select to authenticated using (private.has_role('admin') or private.teaches_class(class_id) or exists (select 1 from public.enrollments e join public.children c on c.id = e.child_id where e.class_id = assignments.class_id and private.has_family_access(c.family_id)));
create policy assignments_teacher_write on public.assignments for all to authenticated using (private.has_role('admin') or private.teaches_class(class_id)) with check ((created_by = (select auth.uid())) and (private.has_role('admin') or private.teaches_class(class_id)));
create policy notes_read on public.teacher_notes for select to authenticated using (private.has_role('admin') or (visibility <> 'admins' and private.teaches_class(class_id)) or (visibility = 'family' and exists (select 1 from public.children c where c.id = teacher_notes.child_id and private.has_family_access(c.family_id))));
create policy notes_teacher_insert on public.teacher_notes for insert to authenticated with check (author_user_id = (select auth.uid()) and (private.has_role('admin') or private.teaches_class(class_id)));
create policy notes_author_update on public.teacher_notes for update to authenticated using (author_user_id = (select auth.uid()) or private.has_role('admin')) with check (author_user_id = (select auth.uid()) or private.has_role('admin'));
create policy posts_read on public.posts for select to authenticated using (published_at is not null and (audience in ('public', 'families') or (audience = 'teachers' and private.has_role('teacher')) or (audience = 'class' and (private.teaches_class(class_id) or exists (select 1 from public.enrollments e join public.children c on c.id = e.child_id where e.class_id = posts.class_id and private.has_family_access(c.family_id))))));
create policy events_read on public.events for select to authenticated using (audience in ('public', 'families') or (audience = 'teachers' and private.has_role('teacher')) or (audience = 'class' and (private.teaches_class(class_id) or exists (select 1 from public.enrollments e join public.children c on c.id = e.child_id where e.class_id = events.class_id and private.has_family_access(c.family_id)))));
create policy documents_read on public.documents for select to authenticated using (private.has_role('admin') or (family_id is not null and private.has_family_access(family_id)));
create policy media_read on public.media for select to authenticated using (
  private.has_role('admin') or (
    private.is_active_user()
    and not exists (select 1 from public.media_consents mc where mc.media_id = media.id and mc.approved = false)
    and (
      audience = 'families'
      or (audience = 'teachers' and private.has_role('teacher'))
      or (audience = 'class' and class_id is not null and (
        private.teaches_class(class_id)
        or exists (select 1 from public.enrollments e join public.children c on c.id = e.child_id where e.class_id = media.class_id and private.has_family_access(c.family_id))
      ))
    )
  )
);
create policy media_consents_read on public.media_consents for select to authenticated using (private.has_role('admin') or exists (select 1 from public.children c where c.id = media_consents.child_id and private.has_family_access(c.family_id)));
create policy invitations_admin on public.invitations for all to authenticated using (private.has_role('admin')) with check (private.has_role('admin'));
create policy audit_admin_read on public.audit_log for select to authenticated using (private.has_role('admin'));

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant insert, update, delete on public.assignments to authenticated;
grant insert, update on public.teacher_notes to authenticated;
grant select, insert, update, delete on public.invitations to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into storage.buckets (id, name, public) values ('family-village-private', 'family-village-private', false)
on conflict (id) do update set public = false;
