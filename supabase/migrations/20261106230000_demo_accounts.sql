-- Reviewer (demo) accounts for the App Store and Google Play reviews.
--
-- A reviewer signs into the live app, and in the live database a normal member
-- can read co-op-wide content: the photo library, news, the calendar, class
-- names, teachers' contact details. A stranger reviewing the app must never see
-- that. So demo accounts are tagged, and the database keeps demo and real
-- content apart in BOTH directions:
--   * a demo account sees only demo content and demo people;
--   * real members never see the demo class, posts, photos or people;
--   * a demo account can only message other demo accounts, so it can never
--     reach a real administrator or family;
--   * a real administrator can still see (and clean up) demo content.
-- The isolation is a restrictive policy layered on top of the existing rules,
-- the same way aal2_required is, so no existing policy changes.

alter table public.profiles add column if not exists is_demo boolean not null default false;
alter table public.posts add column if not exists is_demo boolean not null default false;
alter table public.events add column if not exists is_demo boolean not null default false;
alter table public.classes add column if not exists is_demo boolean not null default false;
alter table public.photos add column if not exists is_demo boolean not null default false;
alter table public.photo_albums add column if not exists is_demo boolean not null default false;

-- Called from row-level security policies, so it must stay executable by
-- signed-in users (the private schema is not exposed through the API).
create or replace function private.is_demo_user()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select coalesce((select p.is_demo from public.profiles p where p.id = (select auth.uid())), false);
$function$;

create policy demo_isolation on public.posts as restrictive for select to authenticated
  using (private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));
create policy demo_isolation on public.events as restrictive for select to authenticated
  using (private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));
create policy demo_isolation on public.classes as restrictive for select to authenticated
  using (private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));
create policy demo_isolation on public.photos as restrictive for select to authenticated
  using (private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));
create policy demo_isolation on public.photo_albums as restrictive for select to authenticated
  using (private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));
create policy demo_isolation on public.profiles as restrictive for select to authenticated
  using (id = (select auth.uid()) or private.is_demo_user() = is_demo or (private.has_role('admin') and not private.is_demo_user()));

-- Messaging: a demo account and a real account can never message each other,
-- including through the "anyone can reach an administrator" rule.
create or replace function private.shares_context(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select a is distinct from b
    and exists (select 1 from public.profiles p where p.id = a and p.status = 'active')
    and exists (select 1 from public.profiles p where p.id = b and p.status = 'active')
    and (select pa.is_demo = pb.is_demo from public.profiles pa, public.profiles pb where pa.id = a and pb.id = b)
    and (
      exists (select 1 from public.user_roles r where r.user_id in (a, b) and r.role = 'admin')
      or exists (
        select 1 from public.family_members x join public.family_members y on y.family_id = x.family_id
        where x.user_id = a and y.user_id = b)
      or (exists (select 1 from public.user_roles r where r.user_id = a and r.role = 'teacher')
          and exists (select 1 from public.user_roles r where r.user_id = b and r.role = 'teacher'))
      or exists (
        select 1 from public.teacher_assignments ta
        join public.enrollments e on e.class_id = ta.class_id and e.status = 'active'
        join public.children c on c.id = e.child_id
        join public.family_members fm on fm.family_id = c.family_id
        where (ta.user_id = a and fm.user_id = b) or (ta.user_id = b and fm.user_id = a))
      or exists (
        select 1
        from public.enrollments e1
        join public.children c1 on c1.id = e1.child_id
        join public.family_members f1 on f1.family_id = c1.family_id and f1.user_id = a
        join public.enrollments e2 on e2.class_id = e1.class_id and e2.status = 'active'
        join public.children c2 on c2.id = e2.child_id
        join public.family_members f2 on f2.family_id = c2.family_id and f2.user_id = b
        where e1.status = 'active')
    );
$function$;

-- --- removing demo content (returns the storage files to delete) ---------------------
create or replace function public.remove_demo_data()
returns text[]
language plpgsql security definer set search_path to ''
as $function$
declare v_paths text[];
begin
  select coalesce(array_agg(p), '{}') into v_paths from (
    select storage_path as p from public.photos where is_demo
    union all select thumb_path from public.photos where is_demo
    union all select m.image_path from public.messages m join public.profiles pr on pr.id = m.sender_id
      where pr.is_demo and m.image_path is not null) x;

  delete from public.conversations where id in (
    select m.conversation_id from public.conversation_members m join public.profiles p on p.id = m.user_id where p.is_demo);
  delete from public.photos where is_demo;
  delete from public.photo_albums where is_demo;
  delete from public.posts where is_demo;
  delete from public.events where is_demo;
  delete from public.families where id in (
    select fm.family_id from public.family_members fm join public.profiles p on p.id = fm.user_id where p.is_demo);
  delete from public.classes where is_demo;
  return v_paths;
end;
$function$;

-- --- the sample world a reviewer sees -------------------------------------------------
-- A demo parent and a demo teacher (their sign-ins already exist), a demo
-- household with two children, one demo class, a couple of news posts and an
-- event, a one-to-one conversation and a class channel with unread messages.
-- Safe to run again: it clears the previous demo content first.
create or replace function public.seed_demo_data(p_parent uuid, p_teacher uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_family uuid;
  v_class uuid;
  v_year uuid;
  v_direct uuid;
  v_channel uuid;
  v_kid1 uuid;
  v_kid2 uuid;
begin
  -- Flag them first, so clearing the old demo world reaches them too.
  update public.profiles set is_demo = true, status = 'active', display_name = 'Demo Parent' where id = p_parent;
  update public.profiles set is_demo = true, status = 'active', display_name = 'Demo Teacher' where id = p_teacher;
  perform public.remove_demo_data();

  delete from public.user_roles where user_id in (p_parent, p_teacher);
  insert into public.user_roles (user_id, role) values (p_parent, 'parent'), (p_teacher, 'teacher');

  select id into v_year from public.school_years where is_current limit 1;

  insert into public.families (display_name) values ('Demo Family') returning id into v_family;
  insert into public.family_members (family_id, user_id, relationship) values (v_family, p_parent, 'Parent');
  insert into public.children (family_id, first_name, birthdate) values (v_family, 'Alex', date '2016-04-12') returning id into v_kid1;
  insert into public.children (family_id, first_name, birthdate) values (v_family, 'Sam', date '2018-09-03') returning id into v_kid2;

  insert into public.classes (title, description, grades, active, is_demo, school_year_id)
  values ('Demo Class: Nature Studies', 'A sample class for app review. Nothing here is real.', '{}', true, true, v_year)
  returning id into v_class;
  insert into public.teacher_assignments (class_id, user_id, assignment_role) values (v_class, p_teacher, 'lead');
  insert into public.enrollments (class_id, child_id, status) values (v_class, v_kid1, 'active'), (v_class, v_kid2, 'active');

  insert into public.posts (author_user_id, title, body, audience, published_at, is_demo) values
    (p_teacher, 'Welcome, reviewers', 'This is a sample news post in a demo account. Everything you see here is made-up sample content.', 'families', now() - interval '2 hours', true),
    (p_teacher, 'Field trip next week', 'We will visit the nature center. Please send a packed lunch.', 'families', now() - interval '1 day', true);
  insert into public.events (title, description, starts_at, ends_at, location, audience, is_demo)
  values ('Demo field trip', 'A sample event.', now() + interval '7 days', now() + interval '7 days 3 hours', 'Nature Center', 'families', true);

  -- A one-to-one conversation and the class channel, each with unread messages for the parent.
  insert into public.conversations (kind, created_by) values ('direct', p_teacher) returning id into v_direct;
  insert into public.conversation_members (conversation_id, user_id, last_read_at)
  values (v_direct, p_teacher, now()), (v_direct, p_parent, now() - interval '1 day');
  insert into public.messages (conversation_id, sender_id, body, created_at) values
    (v_direct, p_teacher, 'Hi! Welcome to Demo Class. Alex did a great job today.', now() - interval '3 hours'),
    (v_direct, p_teacher, 'Let me know if you have any questions.', now() - interval '2 hours');
  update public.conversations set last_message_at = now() - interval '2 hours' where id = v_direct;

  insert into public.conversations (kind, title, class_id, created_by)
  values ('class', 'Demo Class: Nature Studies', v_class, p_teacher) returning id into v_channel;
  perform private.sync_class_conversation(v_class);
  update public.conversation_members set last_read_at = now() - interval '1 day' where conversation_id = v_channel and user_id = p_parent;
  insert into public.messages (conversation_id, sender_id, body, created_at)
  values (v_channel, p_teacher, 'Reminder: bring a notebook and a pencil on Thursday.', now() - interval '1 hour');
  update public.conversations set last_message_at = now() - interval '1 hour' where id = v_channel;

  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  values (p_parent, 'message', 'Demo Teacher', 'Hi! Welcome to Demo Class.', '/family-village/messages?c=' || v_direct::text, 'conversation', v_direct);
end;
$function$;

revoke all on function public.remove_demo_data() from public, anon, authenticated;
revoke all on function public.seed_demo_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_demo_data() to service_role;
grant execute on function public.seed_demo_data(uuid, uuid) to service_role;
