-- Several photos and files in one message.
--
--   * A message can carry up to 10 attachments: photos, PDFs and Word, PowerPoint, Excel and CSV files, each up
--     to 10 MB. (The private bucket already limits file types and size; these are the same types, kept to what
--     this app offers.)
--   * Files live in the private bucket under messages/<conversation id>/, as photos already do, so the existing
--     storage policies (members read and add, the uploader deletes, an administrator can delete) apply.
--   * The first photo is also kept in messages.image_path, so a report's context and older code still show it.
--   * Removing a message (by its sender, or an administrator acting on a report) removes its attachments and
--     returns every file path so the caller can delete the files; the text return type is unchanged, with
--     several paths separated by new lines.

alter table public.messages add column has_attachments boolean not null default false;
alter table public.messages drop constraint messages_has_content;
alter table public.messages add constraint messages_has_content check (
  deleted_at is not null or body is not null or image_path is not null or has_attachments);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  position smallint not null default 0,
  kind text not null check (kind in ('image', 'file')),
  path text not null,
  name text not null check (char_length(name) between 1 and 160),
  mime text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at timestamptz not null default now()
);
create index message_attachments_message_idx on public.message_attachments (message_id, position);

alter table public.message_attachments enable row level security;
-- Whoever can see the message (conversation members, minus people they blocked) can see its attachments.
create policy message_attachments_member_read on public.message_attachments
  for select to authenticated using (
    exists (select 1 from public.messages m where m.id = message_attachments.message_id));

revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;

-- --- sending ------------------------------------------------------------------------------------
drop function public.send_message(uuid, text, text, uuid, uuid[]);
create function public.send_message(
  p_conversation_id uuid, p_body text default null, p_image_path text default null,
  p_reply_to uuid default null, p_mentions uuid[] default '{}', p_attachments jsonb default '[]')
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_kind text;
  v_title text;
  v_posting text;
  v_archived timestamptz;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
  v_mentioned uuid[];
  v_sender text;
  v_att jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_n integer;
  v_images integer := 0;
  v_files integer := 0;
  v_first_image text;
  v_label text;
  v_item jsonb;
  v_mime text;
  v_path text;
  v_i integer := 0;
begin
  if not private.is_conversation_member(p_conversation_id) then
    raise exception 'You are not part of that conversation.';
  end if;
  if jsonb_typeof(v_att) <> 'array' then raise exception 'Those attachments could not be read.'; end if;
  v_n := jsonb_array_length(v_att);
  if v_n > 10 then raise exception 'Add up to 10 photos or files to one message.'; end if;
  if v_body is null and p_image_path is null and v_n = 0 then raise exception 'Write a message or add a photo or file.'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'That message is too long.'; end if;
  if coalesce(cardinality(p_mentions), 0) > 20 then raise exception 'Mention up to 20 people in one message.'; end if;

  select kind, title, posting, archived_at into v_kind, v_title, v_posting, v_archived
  from public.conversations where id = p_conversation_id;

  if v_archived is not null then raise exception 'This channel is archived, so it is read-only.'; end if;
  if v_posting = 'staff' and not (private.has_role('admin') or private.has_role('teacher')) then
    raise exception 'Only administrators and teachers can post in this channel.';
  end if;

  if p_reply_to is not null and not exists (
    select 1 from public.messages where id = p_reply_to and conversation_id = p_conversation_id) then
    raise exception 'That message is no longer here to reply to.';
  end if;

  if v_kind = 'direct' and not exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_conversation_id and m.user_id <> v_me and private.can_message(v_me, m.user_id)) then
    raise exception 'You can no longer message this person.';
  end if;

  if (select count(*) from public.messages where sender_id = v_me and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'You are sending messages very quickly. Wait a moment and try again.';
  end if;

  -- Every attachment must be a file this conversation's folder holds, of a kind the app accepts, and not huge.
  for v_item in select value from jsonb_array_elements(v_att) loop
    v_path := v_item ->> 'path';
    v_mime := lower(coalesce(v_item ->> 'mime', ''));
    if v_path is null or v_path not like 'messages/' || p_conversation_id::text || '/%' or v_path like '%..%' then
      raise exception 'One of the attachments is not in this conversation.';
    end if;
    if char_length(coalesce(v_item ->> 'name', '')) not between 1 and 160 then raise exception 'One of the attachments has no usable name.'; end if;
    if v_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv') then
      raise exception 'That kind of file can''t be sent here. Use a photo, PDF, Word, PowerPoint, Excel or CSV file.';
    end if;
    if coalesce((v_item ->> 'size')::integer, 0) not between 1 and 10485760 then raise exception 'Each file can be up to 10 MB.'; end if;
    if v_mime like 'image/%' then
      v_images := v_images + 1;
      v_first_image := coalesce(v_first_image, v_path);
    else
      v_files := v_files + 1;
    end if;
  end loop;

  v_label := case
    when v_images > 0 and v_files = 0 then case when v_images = 1 then 'Sent a photo' else 'Sent ' || v_images || ' photos' end
    when v_files > 0 and v_images = 0 then case when v_files = 1 then 'Sent a file' else 'Sent ' || v_files || ' files' end
    when v_n > 0 then 'Sent ' || v_n || ' attachments'
    else 'Sent a photo' end;

  -- The first photo is also kept in image_path, so anything that only knows about one photo (a report's context) still shows it.
  insert into public.messages (conversation_id, sender_id, body, image_path, reply_to, has_attachments)
  values (p_conversation_id, v_me, v_body, coalesce(v_first_image, p_image_path), p_reply_to, v_n > 0) returning id into v_id;

  for v_item in select value from jsonb_array_elements(v_att) loop
    insert into public.message_attachments (message_id, position, kind, path, name, mime, size_bytes)
    values (v_id, v_i, case when lower(v_item ->> 'mime') like 'image/%' then 'image' else 'file' end,
            v_item ->> 'path', v_item ->> 'name', lower(v_item ->> 'mime'), (v_item ->> 'size')::integer);
    v_i := v_i + 1;
  end loop;

  update public.conversations set last_message_at = now() where id = p_conversation_id;
  update public.conversation_members set last_read_at = now() where conversation_id = p_conversation_id and user_id = v_me;

  -- Only people actually in the conversation can be mentioned; anything else is ignored.
  select array_agg(m.user_id) into v_mentioned
  from public.conversation_members m
  where m.conversation_id = p_conversation_id and m.user_id = any (coalesce(p_mentions, '{}')) and m.user_id <> v_me;

  perform private.notify_conversation(p_conversation_id, v_me, coalesce(v_body, case when v_n > 0 or p_image_path is not null then v_label end), false, coalesce(v_mentioned, '{}'));

  if v_mentioned is not null then
    select coalesce(nullif(display_name, ''), 'A member') into v_sender from public.profiles where id = v_me;
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select u, 'message',
      v_sender || ' mentioned you' || case when v_kind = 'direct' then '' when v_kind = 'channel' then ' in #' || coalesce(v_title, 'a channel') else ' in ' || coalesce(v_title, 'a group') end,
      left(coalesce(v_body, v_label), 140),
      '/family-village/messages?c=' || p_conversation_id::text, 'conversation', p_conversation_id
    from unnest(v_mentioned) as u
    join public.profiles p on p.id = u and p.status = 'active'
    where not exists (select 1 from public.user_blocks b where b.blocker_id = u and b.blocked_id = v_me);
  end if;

  return v_id;
end;
$function$;

-- --- removing -------------------------------------------------------------------------------------
create or replace function public.delete_own_message(p_message_id uuid)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare v_paths text[];
begin
  select array_remove(array[image_path], null) into v_paths from public.messages
  where id = p_message_id and sender_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'You can only remove your own messages.'; end if;
  select coalesce(array_agg(distinct x), '{}') into v_paths from unnest(
    v_paths || coalesce((select array_agg(path) from public.message_attachments where message_id = p_message_id), '{}')) as x;
  delete from public.message_attachments where message_id = p_message_id;
  update public.messages
  set body = null, image_path = null, has_attachments = false, deleted_at = now(), deleted_by = (select auth.uid())
  where id = p_message_id;
  return nullif(array_to_string(v_paths, E'\n'), '');
end;
$function$;

create or replace function public.resolve_message_report(p_report_id uuid, p_action text, p_note text default null)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare v_msg uuid; v_paths text[] := '{}';
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  if p_action not in ('remove', 'dismiss') then raise exception 'Choose remove or dismiss.'; end if;
  select message_id into v_msg from public.message_reports where id = p_report_id;
  if v_msg is null then raise exception 'That report does not exist.'; end if;

  if p_action = 'remove' then
    select coalesce(array_agg(distinct x), '{}') into v_paths from unnest(
      array_remove(array[(select image_path from public.messages where id = v_msg)], null)
      || coalesce((select array_agg(path) from public.message_attachments where message_id = v_msg), '{}')) as x;
    delete from public.message_attachments where message_id = v_msg;
    update public.messages
    set body = null, image_path = null, has_attachments = false, deleted_at = coalesce(deleted_at, now()), deleted_by = (select auth.uid())
    where id = v_msg;
  end if;

  update public.message_reports
  set status = case when p_action = 'remove' then 'actioned' else 'dismissed' end,
      resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(p_note, 500)
  where message_id = v_msg and status = 'open';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), 'message_report_' || p_action, 'message', v_msg::text, jsonb_build_object('report_id', p_report_id));

  -- The caller deletes the files (if any) through the storage API.
  return nullif(array_to_string(v_paths, E'\n'), '');
end;
$function$;

-- --- a report's context shows every attachment ----------------------------------------------------------
drop function public.admin_report_context(uuid);
create function public.admin_report_context(p_report_id uuid)
returns table (id uuid, sender_name text, body text, image_path text, created_at timestamptz, is_reported boolean, deleted boolean, attachments jsonb)
language plpgsql security definer set search_path to ''
as $function$
declare v_msg uuid; v_conv uuid; v_at timestamptz;
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  select r.message_id, m.conversation_id, m.created_at into v_msg, v_conv, v_at
  from public.message_reports r join public.messages m on m.id = r.message_id where r.id = p_report_id;
  if v_msg is null then raise exception 'That report does not exist.'; end if;

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), 'message_report_viewed', 'message_report', p_report_id::text, jsonb_build_object('message_id', v_msg));

  return query
  select * from (
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, m.id = v_msg, m.deleted_at is not null,
       (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'path', a.path, 'name', a.name) order by a.position), '[]'::jsonb) from public.message_attachments a where a.message_id = m.id)
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.conversation_id = v_conv and m.created_at < v_at order by m.created_at desc limit 3)
    union all
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, m.id = v_msg, m.deleted_at is not null,
       (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'path', a.path, 'name', a.name) order by a.position), '[]'::jsonb) from public.message_attachments a where a.message_id = m.id)
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.id = v_msg)
    union all
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, false, m.deleted_at is not null,
       (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'path', a.path, 'name', a.name) order by a.position), '[]'::jsonb) from public.message_attachments a where a.message_id = m.id)
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.conversation_id = v_conv and m.created_at > v_at order by m.created_at asc limit 3)
  ) ctx order by 5;
end;
$function$;

-- --- the list shows what was sent when there are no words ----------------------------------------------------
create or replace function public.my_conversations()
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
                when m.has_attachments then (
                  select case when count(*) filter (where a.kind = 'image') = count(*) then case when count(*) = 1 then 'Sent a photo' else 'Sent ' || count(*) || ' photos' end
                              when count(*) filter (where a.kind = 'file') = count(*) then case when count(*) = 1 then 'Sent a file' else 'Sent ' || count(*) || ' files' end
                              else 'Sent ' || count(*) || ' attachments' end
                  from public.message_attachments a where a.message_id = m.id)
                else 'Sent a photo' end as preview,
           coalesce(nullif(pp.display_name, ''), m.system_label, 'Member') as sender_name
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

-- --- editing: the words can be cleared when photos or files stay ----------------------------------------------
create or replace function public.edit_own_message(p_message_id uuid, p_body text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_msg public.messages%rowtype;
  v_archived timestamptz;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
  select * into v_msg from public.messages where id = p_message_id and sender_id = v_me and deleted_at is null;
  if not found then raise exception 'You can only edit your own messages.'; end if;
  if v_msg.post_id is not null or v_msg.system_label is not null then
    raise exception 'That message can''t be edited here.';
  end if;
  if not private.is_conversation_member(v_msg.conversation_id) then
    raise exception 'You are not part of that conversation.';
  end if;
  select archived_at into v_archived from public.conversations where id = v_msg.conversation_id;
  if v_archived is not null then raise exception 'This channel is archived, so it is read-only.'; end if;
  if v_msg.created_at < now() - interval '24 hours' then
    raise exception 'Messages can be edited for 24 hours after they are sent.';
  end if;
  if v_body is null and v_msg.image_path is null and not v_msg.has_attachments then raise exception 'A message needs some words or a photo.'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'That message is too long.'; end if;
  if v_body is not distinct from v_msg.body then return; end if;

  insert into public.message_edits (message_id, body) values (p_message_id, v_msg.body);
  update public.messages set body = v_body, edited_at = now() where id = p_message_id;
end;
$function$;


-- --- access ---------------------------------------------------------------------------------------------------
revoke all on function public.send_message(uuid, text, text, uuid, uuid[], jsonb) from public, anon;
revoke all on function public.delete_own_message(uuid) from public, anon;
revoke all on function public.resolve_message_report(uuid, text, text) from public, anon;
revoke all on function public.admin_report_context(uuid) from public, anon;
revoke all on function public.my_conversations() from public, anon;
revoke all on function public.edit_own_message(uuid, text) from public, anon;
grant execute on function public.send_message(uuid, text, text, uuid, uuid[], jsonb) to authenticated;
grant execute on function public.delete_own_message(uuid) to authenticated;
grant execute on function public.resolve_message_report(uuid, text, text) to authenticated;
grant execute on function public.admin_report_context(uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;
grant execute on function public.edit_own_message(uuid, text) to authenticated;
