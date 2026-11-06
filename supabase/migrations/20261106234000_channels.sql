-- Channels: named, shared spaces alongside direct messages and small groups.
--
--   * #Announcements (staff post, everyone reads) and #General (everyone) exist
--     from the start and every active member is in them.
--   * Administrators decide who may create more channels (settings row below).
--   * A channel can follow a class: its members become the class's teachers and
--     enrolled families, kept in step as enrollments change.
--   * Channels can be archived: read-only, tucked away, never deleted.
--   * Publishing a news post drops a card into #Announcements (or the class's
--     channel for a class-only post) so the old habit of announcing in a group
--     chat still works. Those cards do not push again: the news post already did.
--   * Reviewer (demo) accounts are never members of the everyone-channels.
--
-- Everything is a function with the rules inside, as with the rest of messaging.

-- --- shape -------------------------------------------------------------------
alter table public.conversations drop constraint if exists conversations_kind_check;
alter table public.conversations add constraint conversations_kind_check
  check (kind in ('direct', 'group', 'class', 'channel'));

alter table public.conversations drop constraint if exists conversations_class_shape;
alter table public.conversations add constraint conversations_class_shape
  check ((kind <> 'class' or class_id is not null) and (class_id is null or kind in ('class', 'channel')));

-- One conversation per class, whichever kind it is.
drop index if exists public.conversations_one_per_class;
create unique index conversations_one_per_class on public.conversations (class_id) where class_id is not null;

alter table public.conversations
  add column topic text check (topic is null or char_length(topic) <= 200),
  add column posting text not null default 'everyone' check (posting in ('everyone', 'staff')),
  add column audience text not null default 'invite' check (audience in ('invite', 'everyone', 'class')),
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles(id) on delete set null,
  add column system_key text unique;

update public.conversations set audience = 'class' where kind = 'class';

create unique index conversations_channel_title_open
  on public.conversations (lower(title)) where kind = 'channel' and archived_at is null;

-- A message that came from a news post links back to it.
alter table public.messages add column post_id uuid references public.posts(id) on delete set null;

create table public.messaging_settings (
  id boolean primary key default true check (id),
  channel_creators text not null default 'admins' check (channel_creators in ('admins', 'staff', 'members')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.messaging_settings (id) values (true);
alter table public.messaging_settings enable row level security;
create policy messaging_settings_read on public.messaging_settings
  for select to authenticated using (private.is_active_user());
revoke all on public.messaging_settings from anon, authenticated;
grant select on public.messaging_settings to authenticated;

-- --- who may do what -----------------------------------------------------------
create or replace function private.can_create_channel()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.is_active_user() and (
    private.has_role('admin')
    or coalesce((select s.channel_creators = 'members' from public.messaging_settings s), false)
    or (private.has_role('teacher') and coalesce((select s.channel_creators = 'staff' from public.messaging_settings s), false)));
$function$;

create or replace function private.manages_channel(p_conversation_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.is_active_user() and exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id and c.kind = 'channel'
      and (private.has_role('admin') or c.created_by = (select auth.uid())));
$function$;

create or replace function public.can_create_channels()
returns boolean
language sql stable security definer set search_path to ''
as $function$ select private.can_create_channel(); $function$;

create or replace function public.set_channel_creators(p_value text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.has_role('admin') then raise exception 'Only an administrator can change this.'; end if;
  if p_value not in ('admins', 'staff', 'members') then raise exception 'Choose admins, teachers, or all members.'; end if;
  update public.messaging_settings set channel_creators = p_value, updated_by = (select auth.uid()), updated_at = now() where id = true;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), 'channel_creators_changed', 'messaging_settings', 'channel_creators', jsonb_build_object('value', p_value));
end;
$function$;

-- --- membership that follows people ---------------------------------------------
-- Every active member (never a reviewer account) is in every everyone-channel.
create or replace function private.join_everyone_channels()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if new.status = 'active' and not new.is_demo then
    insert into public.conversation_members (conversation_id, user_id)
    select c.id, new.id from public.conversations c
    where c.audience = 'everyone' and c.archived_at is null
    on conflict do nothing;
  end if;
  return null;
end;
$function$;

create trigger profiles_join_everyone_channels
  after insert or update of status on public.profiles
  for each row execute function private.join_everyone_channels();

create or replace function private.leave_everyone_channels_when_demo()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if new.is_demo and not old.is_demo then
    delete from public.conversation_members m
    using public.conversations c
    where m.user_id = new.id and c.id = m.conversation_id and c.audience = 'everyone';
  end if;
  return null;
end;
$function$;

create trigger profiles_leave_everyone_channels_when_demo
  after update of is_demo on public.profiles
  for each row execute function private.leave_everyone_channels_when_demo();

-- The class sync now follows any conversation tied to the class, not only kind 'class'.
create or replace function private.sync_class_conversation(p_class_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_conv uuid;
begin
  select id into v_conv from public.conversations where class_id = p_class_id;
  if v_conv is null then return; end if;

  insert into public.conversation_members (conversation_id, user_id)
  select v_conv, u from private.class_conversation_people(p_class_id) as u
  on conflict do nothing;

  delete from public.conversation_members m
  where m.conversation_id = v_conv
    and m.user_id not in (select private.class_conversation_people(p_class_id))
    and not exists (select 1 from public.user_roles r where r.user_id = m.user_id and r.role = 'admin');
end;
$function$;

create or replace function private.sync_family_conversations_trigger()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_family uuid; v_class uuid;
begin
  v_family := case when tg_op = 'DELETE' then old.family_id else new.family_id end;
  for v_class in
    select distinct cv.class_id from public.conversations cv
    join public.enrollments e on e.class_id = cv.class_id
    join public.children c on c.id = e.child_id
    where cv.class_id is not null and c.family_id = v_family
  loop
    perform private.sync_class_conversation(v_class);
  end loop;
  return null;
end;
$function$;

create or replace function public.open_class_conversation(p_class_id uuid)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
  v_title text;
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;
  select title into v_title from public.classes where id = p_class_id;
  if v_title is null then raise exception 'That class does not exist.'; end if;
  if not (private.has_role('admin') or exists (
    select 1 from public.teacher_assignments ta where ta.class_id = p_class_id and ta.user_id = v_me)) then
    raise exception 'Only the class''s teachers or an administrator can open its channel.';
  end if;

  select id into v_id from public.conversations where class_id = p_class_id;
  if v_id is null then
    insert into public.conversations (kind, title, class_id, created_by, audience)
    values ('class', left(v_title, 80), p_class_id, v_me, 'class') returning id into v_id;
  end if;

  perform private.sync_class_conversation(p_class_id);
  if private.has_role('admin') then
    insert into public.conversation_members (conversation_id, user_id) values (v_id, v_me) on conflict do nothing;
  end if;
  return v_id;
end;
$function$;

-- --- notifications, shared by sending and (silently) by the news link ---------------
create or replace function private.notify_conversation(p_conversation_id uuid, p_sender uuid, p_body text, p_has_image boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_kind text; v_title text; v_name text;
begin
  select kind, title into v_kind, v_title from public.conversations where id = p_conversation_id;
  select coalesce(nullif(display_name, ''), 'A member') into v_name from public.profiles where id = p_sender;

  -- One notification per recipient who has not muted it and has not blocked the
  -- sender; the existing push pipeline turns these into phone notifications.
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select m.user_id, 'message',
    case when v_kind = 'direct' then v_name
         when v_kind = 'channel' then '#' || coalesce(v_title, 'channel') || ' · ' || v_name
         else coalesce(v_title, 'Group') || ' · ' || v_name end,
    case when p_body is not null then left(p_body, 140) else 'Sent a photo' end,
    '/family-village/messages?c=' || p_conversation_id::text, 'conversation', p_conversation_id
  from public.conversation_members m
  join public.profiles p on p.id = m.user_id and p.status = 'active'
  where m.conversation_id = p_conversation_id and m.user_id <> p_sender and not m.muted
    and not exists (select 1 from public.user_blocks b where b.blocker_id = m.user_id and b.blocked_id = p_sender);
end;
$function$;

create or replace function public.send_message(p_conversation_id uuid, p_body text default null, p_image_path text default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_kind text;
  v_posting text;
  v_archived timestamptz;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
begin
  if not private.is_conversation_member(p_conversation_id) then
    raise exception 'You are not part of that conversation.';
  end if;
  if v_body is null and p_image_path is null then raise exception 'Write a message or add a photo.'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'That message is too long.'; end if;

  select kind, posting, archived_at into v_kind, v_posting, v_archived from public.conversations where id = p_conversation_id;

  if v_archived is not null then raise exception 'This channel is archived, so it is read-only.'; end if;
  if v_posting = 'staff' and not (private.has_role('admin') or private.has_role('teacher')) then
    raise exception 'Only administrators and teachers can post in this channel.';
  end if;

  -- A direct conversation ends when either person blocks the other, or the
  -- reason they could talk (a shared class, a household) no longer holds.
  if v_kind = 'direct' and not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conversation_id and m.user_id <> v_me and private.can_message(v_me, m.user_id)) then
    raise exception 'You can no longer message this person.';
  end if;

  if (select count(*) from public.messages where sender_id = v_me and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'You are sending messages very quickly. Wait a moment and try again.';
  end if;

  insert into public.messages (conversation_id, sender_id, body, image_path)
  values (p_conversation_id, v_me, v_body, p_image_path) returning id into v_id;

  update public.conversations set last_message_at = now() where id = p_conversation_id;
  update public.conversation_members set last_read_at = now() where conversation_id = p_conversation_id and user_id = v_me;

  perform private.notify_conversation(p_conversation_id, v_me, v_body, p_image_path is not null and v_body is null);
  return v_id;
end;
$function$;

create or replace function public.leave_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_kind text; v_audience text;
begin
  select kind, audience into v_kind, v_audience from public.conversations where id = p_conversation_id;
  if not (v_kind = 'group' or (v_kind = 'channel' and v_audience = 'invite')) then
    raise exception 'You can only leave groups and invite-only channels. Mute this one to stop its notifications.';
  end if;
  delete from public.conversation_members where conversation_id = p_conversation_id and user_id = (select auth.uid());
end;
$function$;

-- --- creating and running channels -----------------------------------------------
create or replace function public.create_channel(
  p_title text, p_topic text default null, p_posting text default 'everyone',
  p_audience text default 'invite', p_class uuid default null, p_members uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
  v_member uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_topic text := nullif(btrim(coalesce(p_topic, '')), '');
  v_audience text := p_audience;
begin
  if not private.can_create_channel() then raise exception 'You are not able to create channels.'; end if;
  if char_length(v_title) not between 1 and 80 then raise exception 'Give the channel a name (up to 80 characters).'; end if;
  if v_topic is not null and char_length(v_topic) > 200 then raise exception 'Keep the description to 200 characters.'; end if;
  if p_posting not in ('everyone', 'staff') then raise exception 'Choose who may post.'; end if;
  if v_audience not in ('invite', 'everyone') then raise exception 'Choose who is in the channel.'; end if;
  if exists (select 1 from public.conversations where kind = 'channel' and archived_at is null and lower(title) = lower(v_title)) then
    raise exception 'A channel with that name already exists.';
  end if;

  if p_class is not null then
    if not (private.has_role('admin') or exists (select 1 from public.teacher_assignments ta where ta.class_id = p_class and ta.user_id = v_me)) then
      raise exception 'Only an administrator or the class''s teacher can link a channel to a class.';
    end if;
    if exists (select 1 from public.conversations where class_id = p_class) then raise exception 'That class already has a channel.'; end if;
    v_audience := 'class';
  elsif v_audience = 'everyone' and not private.has_role('admin') then
    raise exception 'Only an administrator can make a channel for everyone.';
  end if;

  if v_audience = 'invite' and coalesce(cardinality(p_members), 0) > 200 then raise exception 'That is too many people to add at once.'; end if;

  insert into public.conversations (kind, title, topic, posting, audience, class_id, created_by)
  values ('channel', v_title, v_topic, p_posting, v_audience, p_class, v_me) returning id into v_id;

  insert into public.conversation_members (conversation_id, user_id) values (v_id, v_me);

  if v_audience = 'everyone' then
    insert into public.conversation_members (conversation_id, user_id)
    select v_id, p.id from public.profiles p where p.status = 'active' and not p.is_demo
    on conflict do nothing;
  elsif v_audience = 'class' then
    perform private.sync_class_conversation(p_class);
  else
    foreach v_member in array coalesce(p_members, '{}') loop
      if v_member = v_me then continue; end if;
      if not private.can_message(v_me, v_member) then raise exception 'You can''t message everyone you chose.'; end if;
      insert into public.conversation_members (conversation_id, user_id) values (v_id, v_member) on conflict do nothing;
    end loop;
  end if;
  return v_id;
end;
$function$;

create or replace function public.update_channel(p_id uuid, p_title text, p_topic text, p_posting text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_topic text := nullif(btrim(coalesce(p_topic, '')), '');
  v_system text;
begin
  if not private.manages_channel(p_id) then raise exception 'Only an administrator or the person who created this channel can change it.'; end if;
  if v_topic is not null and char_length(v_topic) > 200 then raise exception 'Keep the description to 200 characters.'; end if;
  select system_key into v_system from public.conversations where id = p_id;

  if v_system is not null then
    -- The built-in channels keep their names and rules; only the description can change.
    update public.conversations set topic = v_topic where id = p_id;
    return;
  end if;

  if char_length(v_title) not between 1 and 80 then raise exception 'Give the channel a name (up to 80 characters).'; end if;
  if p_posting not in ('everyone', 'staff') then raise exception 'Choose who may post.'; end if;
  if exists (select 1 from public.conversations where kind = 'channel' and archived_at is null and lower(title) = lower(v_title) and id <> p_id) then
    raise exception 'A channel with that name already exists.';
  end if;
  update public.conversations set title = v_title, topic = v_topic, posting = p_posting where id = p_id;
end;
$function$;

create or replace function public.set_channel_class(p_id uuid, p_class uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_system text;
begin
  if not private.has_role('admin') then raise exception 'Only an administrator can link a channel to a class.'; end if;
  select system_key into v_system from public.conversations where id = p_id and kind = 'channel';
  if not found then raise exception 'That channel does not exist.'; end if;
  if v_system is not null then raise exception 'The built-in channels can''t be linked to a class.'; end if;

  if p_class is null then
    update public.conversations set class_id = null, audience = 'invite' where id = p_id;
    return;
  end if;
  if not exists (select 1 from public.classes where id = p_class) then raise exception 'That class does not exist.'; end if;
  if exists (select 1 from public.conversations where class_id = p_class and id <> p_id) then raise exception 'That class already has a channel.'; end if;
  update public.conversations set class_id = p_class, audience = 'class' where id = p_id;
  perform private.sync_class_conversation(p_class);
end;
$function$;

create or replace function public.archive_channel(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_system text; v_title text;
begin
  if not private.manages_channel(p_id) then raise exception 'Only an administrator or the person who created this channel can archive it.'; end if;
  select system_key, title into v_system, v_title from public.conversations where id = p_id;
  if v_system is not null then raise exception 'The built-in channels can''t be archived.'; end if;
  if not p_archived and exists (
    select 1 from public.conversations where kind = 'channel' and archived_at is null and lower(title) = lower(v_title) and id <> p_id) then
    raise exception 'Another channel is using that name now. Rename it first.';
  end if;
  update public.conversations
  set archived_at = case when p_archived then now() else null end,
      archived_by = case when p_archived then (select auth.uid()) else null end
  where id = p_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), case when p_archived then 'channel_archived' else 'channel_restored' end, 'conversation', p_id::text, jsonb_build_object('title', v_title));
end;
$function$;

create or replace function public.add_channel_members(p_id uuid, p_members uuid[])
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := (select auth.uid()); v_member uuid;
begin
  if not private.manages_channel(p_id) then raise exception 'Only an administrator or the person who created this channel can add people.'; end if;
  if not exists (select 1 from public.conversations where id = p_id and audience = 'invite' and archived_at is null) then
    raise exception 'People join this channel automatically, or it is archived.';
  end if;
  if coalesce(cardinality(p_members), 0) not between 1 and 200 then raise exception 'Choose 1 to 200 people.'; end if;
  foreach v_member in array p_members loop
    if v_member = v_me then continue; end if;
    if not private.can_message(v_me, v_member) then raise exception 'You can''t message everyone you chose.'; end if;
    insert into public.conversation_members (conversation_id, user_id) values (p_id, v_member) on conflict do nothing;
  end loop;
end;
$function$;

create or replace function public.remove_channel_member(p_id uuid, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.manages_channel(p_id) then raise exception 'Only an administrator or the person who created this channel can remove people.'; end if;
  if not exists (select 1 from public.conversations where id = p_id and audience = 'invite') then
    raise exception 'People in this channel can''t be removed by hand.';
  end if;
  delete from public.conversation_members where conversation_id = p_id and user_id = p_user;
end;
$function$;

-- --- listing (new columns, so the old function is replaced outright) ----------------
drop function public.my_conversations();
create function public.my_conversations()
returns table (
  id uuid, kind text, title text, class_id uuid, last_message_at timestamptz,
  last_preview text, last_sender_name text, unread_count integer, muted boolean,
  member_count integer, other_user_id uuid, other_name text, other_avatar_path text,
  topic text, posting text, audience text, archived_at timestamptz, created_by uuid, system_key text)
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
    c.topic, c.posting, c.audience, c.archived_at, c.created_by, c.system_key
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

create or replace function public.unread_message_count()
returns integer
language sql stable security definer set search_path to ''
as $function$
  select coalesce(sum(unread_count), 0)::int from public.my_conversations() where not muted and archived_at is null;
$function$;

-- --- news posts appear in the announcements ----------------------------------------------
create or replace function private.post_to_channels()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_conv uuid; v_excerpt text; v_body text;
begin
  if new.published_at is null or new.is_demo then return null; end if;
  if tg_op = 'UPDATE' and old.published_at is not null then return null; end if;  -- first publication only

  if new.audience in ('public', 'families') then
    select id into v_conv from public.conversations where system_key = 'announcements' and archived_at is null;
  elsif new.audience = 'class' then
    select id into v_conv from public.conversations where class_id = new.class_id and archived_at is null;
  end if;
  if v_conv is null then return null; end if;

  v_excerpt := btrim(regexp_replace(regexp_replace(regexp_replace(new.body, '<[^>]*>', ' ', 'g'), '&nbsp;', ' ', 'g'), '\s+', ' ', 'g'));
  v_excerpt := replace(replace(v_excerpt, '&amp;', '&'), '&#39;', '''');
  v_body := left(new.title || case when v_excerpt <> '' then E'\n' || left(v_excerpt, 280) else '' end, 4000);

  insert into public.messages (conversation_id, sender_id, body, post_id)
  values (v_conv, new.author_user_id, v_body, new.id);
  update public.conversations set last_message_at = now() where id = v_conv;
  return null;
end;
$function$;

create trigger posts_to_channels
  after insert or update of published_at on public.posts
  for each row execute function private.post_to_channels();

-- --- the two built-in channels -------------------------------------------------------------
insert into public.conversations (kind, title, topic, posting, audience, system_key) values
  ('channel', 'Announcements', 'News from the co-op. Only administrators and teachers post here.', 'staff', 'everyone', 'announcements'),
  ('channel', 'General', 'Anything for the whole co-op.', 'everyone', 'everyone', 'general');

insert into public.conversation_members (conversation_id, user_id)
select c.id, p.id from public.conversations c cross join public.profiles p
where c.audience = 'everyone' and p.status = 'active' and not p.is_demo
on conflict do nothing;

-- --- access ---------------------------------------------------------------------------------
revoke all on function private.can_create_channel() from public, anon, authenticated;
revoke all on function private.manages_channel(uuid) from public, anon, authenticated;
revoke all on function private.join_everyone_channels() from public, anon, authenticated;
revoke all on function private.leave_everyone_channels_when_demo() from public, anon, authenticated;
revoke all on function private.notify_conversation(uuid, uuid, text, boolean) from public, anon, authenticated;
revoke all on function private.post_to_channels() from public, anon, authenticated;
revoke all on function private.sync_class_conversation(uuid) from public, anon, authenticated;
revoke all on function private.sync_family_conversations_trigger() from public, anon, authenticated;

revoke all on function public.can_create_channels() from public, anon;
revoke all on function public.set_channel_creators(text) from public, anon;
revoke all on function public.create_channel(text, text, text, text, uuid, uuid[]) from public, anon;
revoke all on function public.update_channel(uuid, text, text, text) from public, anon;
revoke all on function public.set_channel_class(uuid, uuid) from public, anon;
revoke all on function public.archive_channel(uuid, boolean) from public, anon;
revoke all on function public.add_channel_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_channel_member(uuid, uuid) from public, anon;
revoke all on function public.my_conversations() from public, anon;

grant execute on function public.can_create_channels() to authenticated;
grant execute on function public.set_channel_creators(text) to authenticated;
grant execute on function public.create_channel(text, text, text, text, uuid, uuid[]) to authenticated;
grant execute on function public.update_channel(uuid, text, text, text) to authenticated;
grant execute on function public.set_channel_class(uuid, uuid) to authenticated;
grant execute on function public.archive_channel(uuid, boolean) to authenticated;
grant execute on function public.add_channel_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_channel_member(uuid, uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;
