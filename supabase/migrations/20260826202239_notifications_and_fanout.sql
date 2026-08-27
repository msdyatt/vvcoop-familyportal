-- Notification bell: a per-recipient inbox row, fanned out from posts and
-- teacher notes by SECURITY DEFINER triggers so a family/teacher never needs
-- direct insert access to write someone else's notification.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link_path text,
  subject_type text,
  subject_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_recipient_idx on public.notifications(recipient_user_id, created_at desc);

alter table public.notifications enable row level security;

create policy notifications_read on public.notifications
  for select to authenticated using (recipient_user_id = (select auth.uid()));

create policy notifications_self_update on public.notifications
  for update to authenticated
  using (recipient_user_id = (select auth.uid()))
  with check (recipient_user_id = (select auth.uid()));

create policy notifications_admin_all on public.notifications
  for all to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

-- RLS lets an admin or the owner submit an UPDATE, but only read_at should
-- ever actually change for a non-admin -- RLS can't diff old vs new, so a
-- BEFORE UPDATE trigger fences the column set. Same shape as
-- private.restrict_family_child_update() in
-- 20260824170000_family_child_self_service.sql.
create or replace function private.restrict_notification_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if private.has_role('admin') then return new; end if;
  if new.recipient_user_id is distinct from old.recipient_user_id
    or new.kind is distinct from old.kind
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.link_path is distinct from old.link_path
    or new.subject_type is distinct from old.subject_type
    or new.subject_id is distinct from old.subject_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'A recipient may only mark a notification read.';
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_self_update_guard on public.notifications;
create trigger notifications_self_update_guard
  before update on public.notifications
  for each row execute function private.restrict_notification_self_update();

grant select, update, insert, delete on public.notifications to authenticated;

-- Fan-out 1: a published post notifies exactly who posts_read would let see
-- it (20260820141404_family_village_foundation.sql:251), minus its own
-- author. news-tab.tsx always sets published_at at insert time -- there is
-- no draft-then-publish step in this schema today -- so AFTER INSERT alone
-- is correct; a future draft workflow would need an AFTER UPDATE OF
-- published_at branch added here too.
create or replace function private.notify_post_published()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if new.published_at is null then return new; end if;

  if new.audience in ('public', 'families') then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select p.id, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from public.profiles p
    where p.status = 'active' and p.id <> new.author_user_id;

  elsif new.audience = 'teachers' then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct r.user_id, 'post_published', new.title, left(new.body, 200), '/family-village/teacher', 'post', new.id
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.role = 'teacher' and p.status = 'active' and p.id <> new.author_user_id;

  elsif new.audience = 'class' and new.class_id is not null then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct recipient, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from (
      select ta.user_id as recipient
      from public.teacher_assignments ta
      where ta.class_id = new.class_id
      union
      select fm.user_id as recipient
      from public.enrollments e
      join public.children c on c.id = e.child_id
      join public.family_members fm on fm.family_id = c.family_id
      where e.class_id = new.class_id
    ) recipients
    join public.profiles p on p.id = recipients.recipient
    where p.status = 'active' and p.id <> new.author_user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists posts_notify_published on public.posts;
create trigger posts_notify_published
  after insert on public.posts
  for each row execute function private.notify_post_published();

revoke all on function private.notify_post_published() from public;

-- Fan-out 2: a family-visible note about a child notifies that child's own
-- active adults (notes_read, 20260820141404_family_village_foundation.sql:248,
-- only exposes visibility='family' notes to the family at all), minus the
-- note's own author -- a parent who is also that child's teacher shouldn't
-- get pinged for their own note.
create or replace function private.notify_note_added()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if new.visibility <> 'family' then return new; end if;

  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select fm.user_id, 'note_added',
    'New note about ' || coalesce(c.first_name, 'your child'),
    left(new.body, 200),
    '/family-village/home',
    'teacher_note', new.id
  from public.children c
  join public.family_members fm on fm.family_id = c.family_id
  join public.profiles p on p.id = fm.user_id
  where c.id = new.child_id and p.status = 'active' and p.id <> new.author_user_id;

  return new;
end;
$$;

drop trigger if exists teacher_notes_notify_added on public.teacher_notes;
create trigger teacher_notes_notify_added
  after insert on public.teacher_notes
  for each row execute function private.notify_note_added();

revoke all on function private.notify_note_added() from public;
