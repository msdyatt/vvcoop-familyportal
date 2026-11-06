-- Replies, reactions and mentions.
--
--   * A message can reply to another message in the same conversation.
--   * Members react with one of a few emoji; one tap adds, a second removes.
--   * @mentions: the sender names people in the conversation; each person
--     mentioned is notified directly, even if they muted the conversation, and
--     is not also sent the ordinary notification for the same message.
--
-- As with the rest of messaging, the rules live in the functions.

-- --- replies ---------------------------------------------------------------------
alter table public.messages add column reply_to uuid references public.messages(id) on delete set null;

-- --- reactions ---------------------------------------------------------------------
create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '🎉', '🙏', '😮')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index message_reactions_message_idx on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;
create policy message_reactions_member_read on public.message_reactions
  for select to authenticated using (
    exists (select 1 from public.messages m
            where m.id = message_reactions.message_id and private.is_conversation_member(m.conversation_id)));

revoke all on public.message_reactions from anon, authenticated;
grant select on public.message_reactions to authenticated;

create or replace function public.toggle_reaction(p_message_id uuid, p_emoji text)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_conv uuid;
  v_archived timestamptz;
begin
  select m.conversation_id, c.archived_at into v_conv, v_archived
  from public.messages m join public.conversations c on c.id = m.conversation_id
  where m.id = p_message_id and m.deleted_at is null;

  if v_conv is null or not private.is_conversation_member(v_conv) then raise exception 'You can''t react to that message.'; end if;
  if v_archived is not null then raise exception 'This channel is archived, so it is read-only.'; end if;
  if p_emoji not in ('👍', '❤️', '😂', '🎉', '🙏', '😮') then raise exception 'Choose one of the available reactions.'; end if;

  if exists (select 1 from public.message_reactions where message_id = p_message_id and user_id = v_me and emoji = p_emoji) then
    delete from public.message_reactions where message_id = p_message_id and user_id = v_me and emoji = p_emoji;
    return false;
  end if;

  if (select count(*) from public.message_reactions where user_id = v_me and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'You are reacting very quickly. Wait a moment and try again.';
  end if;
  insert into public.message_reactions (message_id, user_id, emoji) values (p_message_id, v_me, p_emoji);
  return true;
end;
$function$;

-- --- notifications: the ordinary one now skips anyone being mentioned ------------------------
drop function private.notify_conversation(uuid, uuid, text, boolean);
create function private.notify_conversation(p_conversation_id uuid, p_sender uuid, p_body text, p_has_image boolean, p_skip uuid[] default '{}')
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_kind text; v_title text; v_name text;
begin
  select kind, title into v_kind, v_title from public.conversations where id = p_conversation_id;
  select coalesce(nullif(display_name, ''), 'A member') into v_name from public.profiles where id = p_sender;

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
    and m.user_id <> all (coalesce(p_skip, '{}'))
    and not exists (select 1 from public.user_blocks b where b.blocker_id = m.user_id and b.blocked_id = p_sender);
end;
$function$;

-- --- sending, now with a reply target and mentions --------------------------------------------
drop function public.send_message(uuid, text, text);
create function public.send_message(
  p_conversation_id uuid, p_body text default null, p_image_path text default null,
  p_reply_to uuid default null, p_mentions uuid[] default '{}')
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
begin
  if not private.is_conversation_member(p_conversation_id) then
    raise exception 'You are not part of that conversation.';
  end if;
  if v_body is null and p_image_path is null then raise exception 'Write a message or add a photo.'; end if;
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

  insert into public.messages (conversation_id, sender_id, body, image_path, reply_to)
  values (p_conversation_id, v_me, v_body, p_image_path, p_reply_to) returning id into v_id;

  update public.conversations set last_message_at = now() where id = p_conversation_id;
  update public.conversation_members set last_read_at = now() where conversation_id = p_conversation_id and user_id = v_me;

  -- Only people actually in the conversation can be mentioned; anything else is ignored.
  select array_agg(m.user_id) into v_mentioned
  from public.conversation_members m
  where m.conversation_id = p_conversation_id and m.user_id = any (coalesce(p_mentions, '{}')) and m.user_id <> v_me;

  perform private.notify_conversation(p_conversation_id, v_me, v_body, p_image_path is not null and v_body is null, coalesce(v_mentioned, '{}'));

  if v_mentioned is not null then
    select coalesce(nullif(display_name, ''), 'A member') into v_sender from public.profiles where id = v_me;
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select u, 'message',
      v_sender || ' mentioned you' || case when v_kind = 'direct' then '' when v_kind = 'channel' then ' in #' || coalesce(v_title, 'a channel') else ' in ' || coalesce(v_title, 'a group') end,
      case when v_body is not null then left(v_body, 140) else 'Sent a photo' end,
      '/family-village/messages?c=' || p_conversation_id::text, 'conversation', p_conversation_id
    from unnest(v_mentioned) as u
    join public.profiles p on p.id = u and p.status = 'active'
    where not exists (select 1 from public.user_blocks b where b.blocker_id = u and b.blocked_id = v_me);
  end if;

  return v_id;
end;
$function$;

-- --- live updates and access ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end $$;

revoke all on function private.notify_conversation(uuid, uuid, text, boolean, uuid[]) from public, anon, authenticated;
revoke all on function public.toggle_reaction(uuid, text) from public, anon;
revoke all on function public.send_message(uuid, text, text, uuid, uuid[]) from public, anon;
grant execute on function public.toggle_reaction(uuid, text) to authenticated;
grant execute on function public.send_message(uuid, text, text, uuid, uuid[]) to authenticated;
