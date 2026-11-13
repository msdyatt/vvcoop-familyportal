-- Keep the #Announcements card in step with its news post.
--
-- A published news post is shown in #Announcements (or in its class's channel) as a card, a row in
-- messages with post_id set. Until now the card was a one-time copy made on first publication: later
-- edits to the post never reached it, and deleting the post turned the card into an ordinary-looking
-- message from the administrator (post_id is "on delete set null").
--
-- From here the post is the record and the card follows it:
--
--   * One card per post (unique index on messages.post_id). A card removed on a report stays removed.
--   * Headline or text edited: the same card, its preview text updated and marked Edited. The message
--     keeps its id, so reactions and "Seen by" stay. Nobody is notified again.
--   * Audience changed within the same channel (every family <-> public site): nothing to move.
--   * Audience changed to another channel (class <-> every family): the old card is removed and a new
--     card appears in the other channel, silently. Reactions and "Seen by" start again there.
--   * Teaching team only, or no longer published: no card; an existing one is removed.
--   * Post deleted: the card becomes a removed message (so the channel shows "Message removed") and its
--     reactions are cleared.
--
-- The bell and push notice for a post still go out once, when it is first published
-- (notify_post_published), and are not touched here.
--
-- Everything is a trigger on posts, so the News tab, the scheduler and any later way of writing a post
-- all behave the same without each having to remember the card.

-- --- one card per post ---------------------------------------------------------------------------
-- Cards were only ever made on first publication, so there should be no duplicates; if there are, keep
-- the live newest one and retire the rest as removed messages rather than as stray bubbles.
update public.messages m
set deleted_at = coalesce(m.deleted_at, now()), body = null, post_id = null
from (
  select id, row_number() over (partition by post_id order by (deleted_at is null) desc, created_at desc, id) as rn
  from public.messages where post_id is not null
) d
where m.id = d.id and d.rn > 1;

create unique index messages_one_card_per_post on public.messages (post_id) where post_id is not null;

-- --- small helpers --------------------------------------------------------------------------------
-- The channel a post's card lives in, or null when it has none (teaching team only, or the class has no
-- open channel).
create or replace function private.post_card_channel(p_audience public.audience, p_class_id uuid)
returns uuid
language sql stable security definer set search_path to ''
as $function$
  select case
    when p_audience in ('public', 'families') then
      (select id from public.conversations where system_key = 'announcements' and archived_at is null)
    when p_audience = 'class' then
      (select id from public.conversations where class_id = p_class_id and archived_at is null)
    else null end;
$function$;

-- The short text kept on the card: the headline, then the first lines of the post with the markup taken out.
create or replace function private.post_card_text(p_title text, p_body text)
returns text
language plpgsql immutable set search_path to ''
as $function$
declare v_excerpt text;
begin
  v_excerpt := btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p_body, ''), '<[^>]*>', ' ', 'g'), '&nbsp;', ' ', 'g'), '\s+', ' ', 'g'));
  v_excerpt := replace(replace(v_excerpt, '&amp;', '&'), '&#39;', '''');
  return left(p_title || case when v_excerpt <> '' then E'\n' || left(v_excerpt, 280) else '' end, 4000);
end;
$function$;

-- Turn a card into a removed message. Its reactions go with it; the post link is cut so the post can
-- gain a new card (in another channel, say) and so the unique index frees up.
create or replace function private.retire_card(p_message_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  delete from public.message_reactions where message_id = p_message_id;
  update public.messages
  set body = null, post_id = null, deleted_at = coalesce(deleted_at, now()), deleted_by = (select auth.uid())
  where id = p_message_id;
end;
$function$;

-- --- the sync -------------------------------------------------------------------------------------
create or replace function private.sync_post_card()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare
  v_card public.messages%rowtype;
  v_has_card boolean;
  v_channel uuid;
  v_text text;
  v_text_changed boolean := false;
begin
  select * into v_card from public.messages where post_id = new.id;
  v_has_card := found;

  -- A card an administrator removed (a reported message) stays removed, whatever happens to the post.
  if v_has_card and v_card.deleted_at is not null then return null; end if;

  -- Not live (a draft, a scheduled post, a reviewer's sample): no card.
  if new.published_at is null or new.is_demo then
    if v_has_card then perform private.retire_card(v_card.id); end if;
    return null;
  end if;

  v_channel := private.post_card_channel(new.audience, new.class_id);
  if v_channel is null then
    if v_has_card then perform private.retire_card(v_card.id); end if;
    return null;
  end if;

  v_text := private.post_card_text(new.title, new.body);
  if tg_op = 'UPDATE' then
    v_text_changed := old.title is distinct from new.title or old.body is distinct from new.body;
  end if;

  if v_has_card and v_card.conversation_id <> v_channel then
    -- It belongs somewhere else now.
    perform private.retire_card(v_card.id);
    v_has_card := false;
  end if;

  if not v_has_card then
    insert into public.messages (conversation_id, sender_id, body, post_id)
    values (v_channel, new.author_user_id, v_text, new.id);
    update public.conversations set last_message_at = now() where id = v_channel;
  elsif v_text_changed or v_card.body is distinct from v_text then
    -- Same card, same message id: reactions and "Seen by" stay. last_message_at is left alone, so an
    -- edit neither bumps the channel nor counts as unread.
    update public.messages
    set body = v_text, edited_at = case when v_text_changed then now() else edited_at end
    where id = v_card.id;
  end if;
  return null;
end;
$function$;

create or replace function private.retire_post_card()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid;
begin
  select id into v_id from public.messages where post_id = old.id;
  if v_id is not null then perform private.retire_card(v_id); end if;
  return old;
end;
$function$;

drop trigger if exists posts_to_channels on public.posts;
drop function if exists private.post_to_channels();

create trigger posts_sync_card
  after insert or update of title, body, audience, class_id, published_at, is_demo on public.posts
  for each row execute function private.sync_post_card();

create trigger posts_retire_card
  before delete on public.posts
  for each row execute function private.retire_post_card();

-- --- access ---------------------------------------------------------------------------------------
revoke all on function private.post_card_channel(public.audience, uuid) from public, anon, authenticated;
revoke all on function private.post_card_text(text, text) from public, anon, authenticated;
revoke all on function private.retire_card(uuid) from public, anon, authenticated;
revoke all on function private.sync_post_card() from public, anon, authenticated;
revoke all on function private.retire_post_card() from public, anon, authenticated;
