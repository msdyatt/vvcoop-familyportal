-- "Seen by" in channels, for the people who run them.
--
-- A person has seen a message once they have opened the conversation after it was sent (the same
-- conversation_members.last_read_at that drives the unread badge). Only administrators, teachers and the
-- person who made a channel can ask, only in channels and class chats (never in a direct message or a
-- group), and the exact times never leave the database: the screen gets a count per message and, for one
-- message, who has and has not seen it.
--
-- "Everyone who could have seen it": active members of the conversation who joined before the message was
-- sent, not counting the sender.

create or replace function private.can_see_read_status(p_conversation_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.is_conversation_member(p_conversation_id)
    and exists (select 1 from public.conversations c
                where c.id = p_conversation_id and c.kind in ('channel', 'class')
                  and (private.has_role('admin') or private.has_role('teacher') or c.created_by = (select auth.uid())));
$function$;

create or replace function public.message_seen_counts(p_conversation_id uuid, p_message_ids uuid[])
returns table (message_id uuid, seen_count integer, total_count integer)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not private.can_see_read_status(p_conversation_id) then
    raise exception 'Only administrators and teachers can see who has read a message.';
  end if;
  if coalesce(cardinality(p_message_ids), 0) > 100 then raise exception 'Ask about up to 100 messages at a time.'; end if;

  return query
  select m.id,
    (count(*) filter (where cm.last_read_at >= m.created_at))::int,
    count(*)::int
  from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
    and cm.user_id is distinct from m.sender_id and cm.joined_at <= m.created_at
  join public.profiles p on p.id = cm.user_id and p.status = 'active'
  where m.conversation_id = p_conversation_id and m.id = any (coalesce(p_message_ids, '{}')) and m.deleted_at is null
  group by m.id;
end;
$function$;

create or replace function public.message_seen_by(p_message_id uuid)
returns table (user_id uuid, display_name text, avatar_path text, seen boolean)
language plpgsql stable security definer set search_path to ''
as $function$
declare v_conv uuid; v_at timestamptz; v_sender uuid;
begin
  select conversation_id, created_at, sender_id into v_conv, v_at, v_sender
  from public.messages where id = p_message_id and deleted_at is null;
  if v_conv is null or not private.can_see_read_status(v_conv) then
    raise exception 'Only administrators and teachers can see who has read a message.';
  end if;

  return query
  select cm.user_id, coalesce(nullif(p.display_name, ''), 'Member'), p.avatar_path, cm.last_read_at >= v_at
  from public.conversation_members cm
  join public.profiles p on p.id = cm.user_id and p.status = 'active'
  where cm.conversation_id = v_conv and cm.user_id is distinct from v_sender and cm.joined_at <= v_at
  order by cm.last_read_at >= v_at desc, lower(coalesce(nullif(p.display_name, ''), 'Member'));
end;
$function$;

revoke all on function private.can_see_read_status(uuid) from public, anon, authenticated;
revoke all on function public.message_seen_counts(uuid, uuid[]) from public, anon;
revoke all on function public.message_seen_by(uuid) from public, anon;
grant execute on function public.message_seen_counts(uuid, uuid[]) to authenticated;
grant execute on function public.message_seen_by(uuid) to authenticated;
