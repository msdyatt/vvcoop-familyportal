-- #Reports: an administrators-only channel where reports are talked through.
--
-- When someone reports a message (message_reports) or a photo (photo_reports),
-- a card is posted into #Reports with the essentials: what it is, who reported
-- it, the reason, a short snippet (messages only, no more than the review
-- screen already shows an administrator) and a link to the review screen.
-- Administrators discuss it by replying to the card. The moderation itself
-- (remove, dismiss) still happens on the existing review screen, and when it
-- does, a "Resolved: ..." reply lands under the card.
--
--   * The channel has audience 'admins': its members are exactly the active,
--     non-reviewer administrators, kept in step as roles and accounts change.
--     Because it is not an 'invite' channel, the existing rules already stop
--     anyone leaving it, adding to it or removing from it by hand; and as a
--     built-in channel (system_key) it cannot be archived, renamed or linked
--     to a class. Reviewer (demo) accounts are never members.
--   * Posting is by members only, so nobody but an administrator can write in it.
--   * One notification per new report goes to each member who has not muted
--     the channel (replacing the unconditional notification to every
--     administrator that report_message/report_photo used to send).
--   * The reporter's name appears only in these cards, which only administrators
--     can read. If a named account is later deleted, the name is scrubbed from
--     the cards.
--   * Cards are posted by triggers on the report tables, so every way a report
--     can be created or settled is covered, and a repeat report (which inserts
--     nothing) posts nothing.

-- --- shape --------------------------------------------------------------------------
alter table public.conversations drop constraint if exists conversations_audience_check;
alter table public.conversations add constraint conversations_audience_check
  check (audience in ('invite', 'everyone', 'class', 'admins'));

-- A message the system posts rather than a person: a label instead of a sender,
-- and an optional link inside the app.
alter table public.messages
  add column link_path text check (link_path is null or link_path like '/family-village/%'),
  add column system_label text check (system_label is null or char_length(system_label) <= 40),
  add column system_subjects uuid[] not null default '{}';

-- Which card belongs to which report. No foreign key to the report: a removed
-- photo takes its report with it, and the card must outlive that.
create table public.report_threads (
  kind text not null check (kind in ('message', 'photo')),
  report_id uuid not null,
  root_message_id uuid not null references public.messages(id) on delete cascade,
  primary key (kind, report_id)
);
alter table public.report_threads enable row level security;
revoke all on public.report_threads from anon, authenticated;

-- --- the channel ----------------------------------------------------------------------
-- If someone already made a channel called Reports, give the built-in one the name.
update public.conversations
set title = 'Reports (earlier)'
where kind = 'channel' and lower(title) = 'reports' and system_key is null and archived_at is null;

insert into public.conversations (kind, title, topic, posting, audience, system_key)
values ('channel', 'Reports', 'Reported messages and photos. Only administrators can see this channel.', 'everyone', 'admins', 'reports')
on conflict (system_key) do nothing;

create or replace function private.reports_channel_id()
returns uuid
language sql stable security definer set search_path to ''
as $function$
  select id from public.conversations where system_key = 'reports';
$function$;

create or replace function private.sync_reports_channel_members()
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id();
begin
  if v_chan is null then return; end if;
  insert into public.conversation_members (conversation_id, user_id)
  select v_chan, p.id
  from public.profiles p join public.user_roles r on r.user_id = p.id and r.role = 'admin'
  where p.status = 'active' and not p.is_demo
  on conflict do nothing;

  delete from public.conversation_members m
  where m.conversation_id = v_chan
    and not exists (
      select 1 from public.profiles p join public.user_roles r on r.user_id = p.id and r.role = 'admin'
      where p.id = m.user_id and p.status = 'active' and not p.is_demo);
end;
$function$;

create or replace function private.sync_reports_channel_members_trigger()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.sync_reports_channel_members();
  return null;
end;
$function$;

create trigger user_roles_sync_reports_channel
  after insert or update or delete on public.user_roles
  for each statement execute function private.sync_reports_channel_members_trigger();
create trigger profiles_sync_reports_channel
  after insert or update of status, is_demo or delete on public.profiles
  for each statement execute function private.sync_reports_channel_members_trigger();

select private.sync_reports_channel_members();

-- --- small helpers -----------------------------------------------------------------------
create or replace function private.name_of(p_user uuid)
returns text
language sql stable security definer set search_path to ''
as $function$
  select coalesce((select coalesce(nullif(display_name, ''), 'A member') from public.profiles where id = p_user), 'A former member');
$function$;

create or replace function private.post_system_message(
  p_conversation_id uuid, p_body text, p_link text, p_subjects uuid[], p_reply_to uuid default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid;
begin
  insert into public.messages (conversation_id, sender_id, body, link_path, system_label, system_subjects, reply_to)
  values (p_conversation_id, null, left(p_body, 4000), p_link, 'Reports', coalesce(p_subjects, '{}'), p_reply_to)
  returning id into v_id;
  update public.conversations set last_message_at = now() where id = p_conversation_id;
  return v_id;
end;
$function$;

-- One push/in-app notification per administrator who has not muted the channel.
create or replace function private.notify_reports_channel(p_title text, p_body text, p_except uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id();
begin
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select m.user_id, 'message', p_title, left(p_body, 140),
    '/family-village/messages?c=' || v_chan::text, 'conversation', v_chan
  from public.conversation_members m
  join public.profiles p on p.id = m.user_id and p.status = 'active'
  where m.conversation_id = v_chan and not m.muted and m.user_id is distinct from p_except;
end;
$function$;

-- --- message reports --------------------------------------------------------------------------
create or replace function private.render_message_report_card(p_report_id uuid)
returns text
language sql stable security definer set search_path to ''
as $function$
  select 'New report: message' || E'\n'
    || private.name_of(r.reporter_id) || ' reported a message from ' || private.name_of(m.sender_id)
    || ' in ' || case when c.kind = 'direct' then 'a direct message' else coalesce(c.title, 'a conversation') end || '.' || E'\n'
    || 'Reason: ' || r.reason || E'\n'
    || 'Message: ' || case when m.deleted_at is not null then '(removed)'
                           when m.body is not null and m.body <> '' then '“' || left(m.body, 160) || '”'
                           else '(photo)' end
  from public.message_reports r
  join public.messages m on m.id = r.message_id
  join public.conversations c on c.id = m.conversation_id
  where r.id = p_report_id;
$function$;

create or replace function private.post_message_report_card()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id(); v_card uuid; v_sender uuid;
begin
  if v_chan is null then return null; end if;
  select sender_id into v_sender from public.messages where id = new.message_id;
  v_card := private.post_system_message(v_chan, private.render_message_report_card(new.id),
    '/family-village/admin?tab=message-reports#report-' || new.id::text,
    array_remove(array[new.reporter_id, v_sender], null));
  insert into public.report_threads (kind, report_id, root_message_id) values ('message', new.id, v_card);
  perform private.notify_reports_channel('#Reports · message reported', 'Message reported: ' || new.reason, new.reporter_id);
  return null;
end;
$function$;

create trigger message_reports_post_card
  after insert on public.message_reports
  for each row execute function private.post_message_report_card();

create or replace function private.post_message_report_resolved()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id(); v_root uuid;
begin
  if v_chan is null or old.status <> 'open' or new.status = 'open' then return null; end if;
  select root_message_id into v_root from public.report_threads where kind = 'message' and report_id = new.id;
  if v_root is null then return null; end if;

  -- A removed message's words don't stay behind in the card.
  if new.status = 'actioned' then
    update public.messages set body = private.render_message_report_card(new.id) where id = v_root;
  end if;

  perform private.post_system_message(v_chan,
    'Resolved: ' || case when new.status = 'actioned' then 'message removed' else 'dismissed' end
      || ' by ' || case when new.resolved_by is null then 'an administrator' else private.name_of(new.resolved_by) end || '.',
    null, array_remove(array[new.resolved_by], null), v_root);
  return null;
end;
$function$;

create trigger message_reports_post_resolved
  after update of status on public.message_reports
  for each row execute function private.post_message_report_resolved();

-- --- photo reports -------------------------------------------------------------------------------
create or replace function private.post_photo_report_card()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare
  v_chan uuid := private.reports_channel_id();
  v_card uuid;
  v_uploader uuid; v_caption text; v_class text;
begin
  if v_chan is null then return null; end if;
  select ph.uploaded_by, ph.caption, c.title into v_uploader, v_caption, v_class
  from public.photos ph left join public.classes c on c.id = ph.class_id where ph.id = new.photo_id;

  v_card := private.post_system_message(v_chan,
    'New report: photo' || E'\n'
      || private.name_of(new.reporter_id) || ' reported a photo added by ' || private.name_of(v_uploader) || '.' || E'\n'
      || case when v_class is not null then 'Class: ' || v_class || E'\n' else '' end
      || case when nullif(v_caption, '') is not null then 'Caption: ' || left(v_caption, 160) || E'\n' else '' end
      || 'Reason: ' || new.reason,
    '/family-village/admin?tab=message-reports#photo-report-' || new.id::text,
    array_remove(array[new.reporter_id, v_uploader], null));
  insert into public.report_threads (kind, report_id, root_message_id) values ('photo', new.id, v_card);
  perform private.notify_reports_channel('#Reports · photo reported', 'Photo reported: ' || new.reason, new.reporter_id);
  return null;
end;
$function$;

create trigger photo_reports_post_card
  after insert on public.photo_reports
  for each row execute function private.post_photo_report_card();

-- Dismissed: the report row is updated.
create or replace function private.post_photo_report_dismissed()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id(); v_root uuid;
begin
  if v_chan is null or old.status <> 'open' or new.status = 'open' then return null; end if;
  select root_message_id into v_root from public.report_threads where kind = 'photo' and report_id = new.id;
  if v_root is null then return null; end if;
  perform private.post_system_message(v_chan,
    'Resolved: dismissed by ' || case when new.resolved_by is null then 'an administrator' else private.name_of(new.resolved_by) end || '.',
    null, array_remove(array[new.resolved_by], null), v_root);
  return null;
end;
$function$;

create trigger photo_reports_post_dismissed
  after update of status on public.photo_reports
  for each row execute function private.post_photo_report_dismissed();

-- Removed: the photo, and with it the report row, is deleted.
create or replace function private.post_photo_report_removed()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_chan uuid := private.reports_channel_id(); v_root uuid; v_actor uuid := (select auth.uid());
begin
  if v_chan is null or old.status <> 'open' then return old; end if;
  select root_message_id into v_root from public.report_threads where kind = 'photo' and report_id = old.id;
  if v_root is not null then
    perform private.post_system_message(v_chan,
      'Resolved: photo removed' || case when v_actor is null then '' else ' by ' || private.name_of(v_actor) end || '.',
      null, array_remove(array[v_actor], null), v_root);
  end if;
  return old;
end;
$function$;

create trigger photo_reports_post_removed
  before delete on public.photo_reports
  for each row execute function private.post_photo_report_removed();

-- --- the reporter's own entry points: no more unconditional admin notification ---------------------
-- Same as before except that the notification now comes from the card above
-- (so a muted #Reports is respected), and the system's own cards can't be reported.
create or replace function public.report_message(p_message_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_conv uuid;
  v_system text;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select conversation_id, system_label into v_conv, v_system from public.messages where id = p_message_id;
  if v_conv is null or v_system is not null or not private.is_conversation_member(v_conv) then
    raise exception 'You can only report messages in your own conversations.';
  end if;
  if char_length(v_reason) not between 1 and 500 then raise exception 'Say briefly what is wrong (up to 500 characters).'; end if;

  insert into public.message_reports (message_id, reporter_id, reason)
  values (p_message_id, (select auth.uid()), v_reason) on conflict do nothing;
end;
$function$;

create or replace function public.report_photo(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_reason text := btrim(coalesce(p_reason, ''));
begin
  -- This function runs as its owner, so visibility is checked here by hand.
  if not exists (
    select 1 from public.photos p where p.id = p_id and private.is_active_user() and (
      p.uploaded_by = (select auth.uid()) or private.has_role('admin')
      or (p.status = 'published' and (p.visibility = 'coop' or private.can_see_class_media(p.class_id))))) then
    raise exception 'You can only report photos you can see.';
  end if;
  if char_length(v_reason) not between 1 and 500 then raise exception 'Say briefly what is wrong (up to 500 characters).'; end if;

  insert into public.photo_reports (photo_id, reporter_id, reason) values (p_id, (select auth.uid()), v_reason) on conflict do nothing;
end;
$function$;

-- --- listing: the system's cards have a name, not "Member" -----------------------------------------------
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

-- --- erasure: a deleted account's name leaves the cards -------------------------------------------------
create or replace function private.scrub_system_messages_for_deleted_profile()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if nullif(old.display_name, '') is not null then
    update public.messages
    set body = replace(body, old.display_name, 'a former member')
    where old.id = any (system_subjects) and body is not null;
  end if;
  return old;
end;
$function$;

create trigger profiles_scrub_system_messages
  before delete on public.profiles
  for each row execute function private.scrub_system_messages_for_deleted_profile();

-- --- access -------------------------------------------------------------------------------------------------
revoke all on function private.reports_channel_id() from public, anon, authenticated;
revoke all on function private.sync_reports_channel_members() from public, anon, authenticated;
revoke all on function private.sync_reports_channel_members_trigger() from public, anon, authenticated;
revoke all on function private.name_of(uuid) from public, anon, authenticated;
revoke all on function private.post_system_message(uuid, text, text, uuid[], uuid) from public, anon, authenticated;
revoke all on function private.notify_reports_channel(text, text, uuid) from public, anon, authenticated;
revoke all on function private.render_message_report_card(uuid) from public, anon, authenticated;
revoke all on function private.post_message_report_card() from public, anon, authenticated;
revoke all on function private.post_message_report_resolved() from public, anon, authenticated;
revoke all on function private.post_photo_report_card() from public, anon, authenticated;
revoke all on function private.post_photo_report_dismissed() from public, anon, authenticated;
revoke all on function private.post_photo_report_removed() from public, anon, authenticated;
revoke all on function private.scrub_system_messages_for_deleted_profile() from public, anon, authenticated;

revoke all on function public.report_message(uuid, text) from public, anon;
revoke all on function public.report_photo(uuid, text) from public, anon;
revoke all on function public.my_conversations() from public, anon;
grant execute on function public.report_message(uuid, text) to authenticated;
grant execute on function public.report_photo(uuid, text) to authenticated;
grant execute on function public.my_conversations() to authenticated;
