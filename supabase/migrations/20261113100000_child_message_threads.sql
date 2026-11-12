-- "Message the parents": one private thread per (teacher, child), replacing the
-- per-child teacher notes as the way a teacher reaches a family.
--
-- The thread is an ordinary group conversation, so the existing messaging
-- screens, notifications, mutes, reports and blocks all apply. What is new:
--
--   * public.start_child_conversation(child, teacher) opens it, or returns the
--     existing one. A teacher starts it for a child in a class they are
--     assigned to; a parent starts it for a teacher of their own child's class.
--     Either way it is the SAME thread: the teacher plus every parent or
--     guardian of that child who has an active portal account.
--   * Members follow the facts. A second parent who joins the portal later is
--     added; an adult removed from the household, or a teacher no longer
--     assigned to any of the child's classes, is taken out. History stays.
--   * Nobody can leave one of these threads (muting is still allowed), so a
--     parent cannot drop out and then be silently put back.
--   * Only people in the thread ever see it, and nobody else's family is in it.
--     The teacher gets no wider reach than before: the RPC checks the
--     teacher's assignment itself, and each parent still has to pass
--     private.can_message (active accounts, no blocks, demo kept apart).
--
-- Existing teacher notes are untouched; only the screens that wrote and read
-- them go away.

-- --- shape -----------------------------------------------------------------------
alter table public.conversations
  add column child_id uuid references public.children(id) on delete set null,
  add column thread_teacher_id uuid references public.profiles(id) on delete set null,
  add constraint conversations_child_thread_shape check (child_id is null or kind = 'group');

create unique index conversations_one_thread_per_child_teacher
  on public.conversations (child_id, thread_teacher_id)
  where child_id is not null and thread_teacher_id is not null;

-- --- membership that follows people ----------------------------------------------
create or replace function private.sync_child_threads(p_child_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_thread record;
  v_family uuid;
  v_teaching boolean;
begin
  if p_child_id is null then return; end if;
  select family_id into v_family from public.children where id = p_child_id;

  for v_thread in
    select c.id, c.thread_teacher_id as teacher
    from public.conversations c
    where c.child_id = p_child_id and c.thread_teacher_id is not null
  loop
    v_teaching := exists (
      select 1
      from public.teacher_assignments ta
      join public.enrollments e on e.class_id = ta.class_id and e.status = 'active' and e.child_id = p_child_id
      join public.profiles p on p.id = ta.user_id and p.status = 'active'
      where ta.user_id = v_thread.teacher);

    if v_teaching then
      insert into public.conversation_members (conversation_id, user_id)
      select v_thread.id, u
      from (
        select v_thread.teacher as u
        union
        select fm.user_id
        from public.family_members fm
        join public.profiles p on p.id = fm.user_id and p.status = 'active'
        where fm.family_id = v_family and fm.user_id <> v_thread.teacher
          and private.can_message(v_thread.teacher, fm.user_id)
      ) people
      on conflict do nothing;
    end if;

    -- Out go adults who are no longer in the child's household, and the teacher
    -- once they no longer teach the child. (Someone who is merely suspended or
    -- blocked stays; they can't read it anyway and come back with their access.)
    delete from public.conversation_members m
    where m.conversation_id = v_thread.id
      and not (
        (m.user_id = v_thread.teacher and v_teaching)
        or exists (select 1 from public.family_members fm where fm.family_id = v_family and fm.user_id = m.user_id));
  end loop;
end;
$function$;

create or replace function private.sync_child_threads_enrollment()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if tg_op in ('INSERT', 'UPDATE') then perform private.sync_child_threads(new.child_id); end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.child_id is distinct from new.child_id) then
    perform private.sync_child_threads(old.child_id);
  end if;
  return null;
end;
$function$;

create or replace function private.sync_child_threads_class()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_new uuid; v_old uuid; v_child uuid;
begin
  v_new := case when tg_op = 'DELETE' then null else new.class_id end;
  v_old := case when tg_op = 'INSERT' then null else old.class_id end;
  for v_child in
    select distinct e.child_id from public.enrollments e
    where e.class_id in (coalesce(v_new, v_old), coalesce(v_old, v_new))
  loop
    perform private.sync_child_threads(v_child);
  end loop;
  return null;
end;
$function$;

-- family_members and children both carry family_id.
create or replace function private.sync_child_threads_family()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_new uuid; v_old uuid; v_child uuid;
begin
  v_new := case when tg_op = 'DELETE' then null else new.family_id end;
  v_old := case when tg_op = 'INSERT' then null else old.family_id end;
  for v_child in
    select distinct c.id from public.children c
    where c.family_id in (coalesce(v_new, v_old), coalesce(v_old, v_new))
  loop
    perform private.sync_child_threads(v_child);
  end loop;
  return null;
end;
$function$;

create or replace function private.sync_child_threads_profile()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_child uuid;
begin
  for v_child in
    select distinct cv.child_id from public.conversations cv
    where cv.child_id is not null
      and (cv.thread_teacher_id = new.id
           or exists (select 1 from public.children ch join public.family_members fm on fm.family_id = ch.family_id
                      where ch.id = cv.child_id and fm.user_id = new.id))
  loop
    perform private.sync_child_threads(v_child);
  end loop;
  return null;
end;
$function$;

create trigger enrollments_sync_child_threads
  after insert or update or delete on public.enrollments
  for each row execute function private.sync_child_threads_enrollment();
create trigger teacher_assignments_sync_child_threads
  after insert or update or delete on public.teacher_assignments
  for each row execute function private.sync_child_threads_class();
create trigger family_members_sync_child_threads
  after insert or update or delete on public.family_members
  for each row execute function private.sync_child_threads_family();
create trigger children_sync_child_threads
  after update of family_id on public.children
  for each row execute function private.sync_child_threads_family();
create trigger profiles_sync_child_threads
  after update of status on public.profiles
  for each row execute function private.sync_child_threads_profile();

-- --- opening a thread ----------------------------------------------------------------
-- Returns the conversation id. Safe to call again: it returns the same thread
-- (and brings its members up to date).
create or replace function public.start_child_conversation(p_child_id uuid, p_teacher_id uuid default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_family uuid;
  v_first text;
  v_teacher uuid;
  v_teacher_name text;
  v_title text;
  v_id uuid;
  v_reachable integer;
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;

  select family_id, first_name into v_family, v_first from public.children where id = p_child_id;
  if v_family is null then raise exception 'You can''t message about that student.'; end if;

  if p_teacher_id is null or p_teacher_id = v_me then
    -- A teacher starting it: they must be assigned to a class the child is in.
    v_teacher := v_me;
  else
    -- A parent starting it: they must be in the child's household.
    if not exists (select 1 from public.family_members fm where fm.family_id = v_family and fm.user_id = v_me) then
      raise exception 'You can''t message about that student.';
    end if;
    v_teacher := p_teacher_id;
  end if;

  if not exists (
    select 1
    from public.teacher_assignments ta
    join public.enrollments e on e.class_id = ta.class_id and e.status = 'active' and e.child_id = p_child_id
    where ta.user_id = v_teacher) then
    raise exception 'You can''t message about that student.';
  end if;

  if v_teacher <> v_me and not private.can_message(v_me, v_teacher) then
    raise exception 'You can''t message that person.';
  end if;

  select count(*) into v_reachable
  from public.family_members fm
  join public.profiles p on p.id = fm.user_id and p.status = 'active'
  where fm.family_id = v_family and fm.user_id <> v_teacher and private.can_message(v_teacher, fm.user_id);
  if v_reachable = 0 then
    raise exception 'No parent or guardian of this student is in the portal yet.';
  end if;

  select coalesce(nullif(display_name, ''), 'Teacher') into v_teacher_name from public.profiles where id = v_teacher;
  v_title := left(v_first || ' · ' || v_teacher_name, 80);

  insert into public.conversations (kind, title, created_by, child_id, thread_teacher_id)
  values ('group', v_title, v_me, p_child_id, v_teacher)
  on conflict (child_id, thread_teacher_id) where child_id is not null and thread_teacher_id is not null do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.conversations where child_id = p_child_id and thread_teacher_id = v_teacher;
    update public.conversations set title = v_title where id = v_id and title is distinct from v_title;
  end if;

  perform private.sync_child_threads(p_child_id);
  return v_id;
end;
$function$;

-- The adults of the child who are not in the portal yet, by name, for the note
-- at the top of the thread. Only members of the thread may ask.
create or replace function public.child_thread_not_in_portal(p_conversation_id uuid)
returns text[]
language sql stable security definer set search_path to ''
as $function$
  select coalesce(array_agg(coalesce(nullif(p.display_name, ''), 'Another adult') order by p.display_name), '{}')
  from public.conversations c
  join public.children ch on ch.id = c.child_id
  join public.family_members fm on fm.family_id = ch.family_id
  join public.profiles p on p.id = fm.user_id
  where c.id = p_conversation_id and private.is_conversation_member(c.id)
    and p.status = 'pending' and fm.user_id <> c.thread_teacher_id;
$function$;

-- --- leaving ------------------------------------------------------------------------
create or replace function public.leave_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_kind text; v_audience text; v_child uuid;
begin
  select kind, audience, child_id into v_kind, v_audience, v_child from public.conversations where id = p_conversation_id;
  if v_child is not null then
    raise exception 'A conversation about a student can''t be left. Mute it to stop its notifications.';
  end if;
  if not (v_kind = 'group' or (v_kind = 'channel' and v_audience = 'invite')) then
    raise exception 'You can only leave groups and invite-only channels. Mute this one to stop its notifications.';
  end if;
  delete from public.conversation_members where conversation_id = p_conversation_id and user_id = (select auth.uid());
end;
$function$;

-- --- listing: say which conversations are about a student -------------------------------
drop function public.my_conversations();
create function public.my_conversations()
returns table (
  id uuid, kind text, title text, class_id uuid, last_message_at timestamptz,
  last_preview text, last_sender_name text, unread_count integer, muted boolean,
  member_count integer, other_user_id uuid, other_name text, other_avatar_path text,
  topic text, posting text, audience text, archived_at timestamptz, created_by uuid, system_key text,
  child_thread boolean)
language sql stable security definer set search_path to ''
as $function$
  select c.id, c.kind, c.title, c.class_id, c.last_message_at,
    lm.preview, lm.sender_name,
    (select count(*)::int from public.messages m
      where m.conversation_id = c.id and m.created_at > me.last_read_at and m.deleted_at is null
        and m.sender_id is distinct from (select auth.uid())
        and not exists (select 1 from public.user_blocks b
          where b.blocker_id = (select auth.uid()) and b.blocked_id = m.sender_id)),
    me.muted,
    (select count(*)::int from public.conversation_members x where x.conversation_id = c.id),
    oth.user_id, oth.name, oth.avatar_path,
    c.topic, c.posting, c.audience, c.archived_at, c.created_by, c.system_key,
    c.child_id is not null
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = (select auth.uid())
  left join lateral (
    select case when m.deleted_at is not null then 'Message removed'
                when m.post_id is not null then 'Announcement: ' || left(coalesce(m.body, ''), 100)
                when m.body is not null and m.body <> '' then left(m.body, 120)
                else 'Sent a photo' end as preview,
           coalesce(nullif(pp.display_name, ''), 'Member') as sender_name
    from public.messages m left join public.profiles pp on pp.id = m.sender_id
    where m.conversation_id = c.id
      and not exists (select 1 from public.user_blocks b
        where b.blocker_id = (select auth.uid()) and b.blocked_id = m.sender_id)
    order by m.created_at desc limit 1) lm on true
  left join lateral (
    select p.id as user_id, coalesce(nullif(p.display_name, ''), 'Member') as name, p.avatar_path
    from public.conversation_members x join public.profiles p on p.id = x.user_id
    where c.kind = 'direct' and x.conversation_id = c.id and x.user_id <> (select auth.uid()) limit 1) oth on true
  where private.is_active_user()
  order by c.last_message_at desc;
$function$;

-- --- access -------------------------------------------------------------------------------
revoke all on function private.sync_child_threads(uuid) from public, anon, authenticated;
revoke all on function private.sync_child_threads_enrollment() from public, anon, authenticated;
revoke all on function private.sync_child_threads_class() from public, anon, authenticated;
revoke all on function private.sync_child_threads_family() from public, anon, authenticated;
revoke all on function private.sync_child_threads_profile() from public, anon, authenticated;

revoke all on function public.start_child_conversation(uuid, uuid) from public, anon;
revoke all on function public.child_thread_not_in_portal(uuid) from public, anon;
revoke all on function public.leave_conversation(uuid) from public, anon;
revoke all on function public.my_conversations() from public, anon;

grant execute on function public.start_child_conversation(uuid, uuid) to authenticated;
grant execute on function public.child_thread_not_in_portal(uuid) to authenticated;
grant execute on function public.leave_conversation(uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;
