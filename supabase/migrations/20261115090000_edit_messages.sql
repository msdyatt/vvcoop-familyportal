-- Editing a message you sent.
--
--   * Only the sender, only their own words, for 24 hours after sending.
--   * Not a News or system card (their text belongs to the post or to the system), not a removed
--     message, not in an archived channel.
--   * The text before each edit is kept in message_edits, readable by administrators only, so an
--     edit cannot be used to wipe out what a report was about.
--   * Nobody is notified again; the message shows "Edited".
--
-- As with the rest of messaging, the rules live in the function.

alter table public.messages add column edited_at timestamptz;

create table public.message_edits (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  body text,
  edited_at timestamptz not null default now()
);
create index message_edits_message_idx on public.message_edits (message_id, edited_at);

alter table public.message_edits enable row level security;
create policy message_edits_admin_read on public.message_edits
  for select to authenticated using (private.has_role('admin'));

revoke all on public.message_edits from anon, authenticated;
grant select on public.message_edits to authenticated;

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
  if v_body is null and v_msg.image_path is null then raise exception 'A message needs some words or a photo.'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'That message is too long.'; end if;
  if v_body is not distinct from v_msg.body then return; end if;

  insert into public.message_edits (message_id, body) values (p_message_id, v_msg.body);
  update public.messages set body = v_body, edited_at = now() where id = p_message_id;
end;
$function$;

revoke all on function public.edit_own_message(uuid, text) from public, anon;
grant execute on function public.edit_own_message(uuid, text) to authenticated;
