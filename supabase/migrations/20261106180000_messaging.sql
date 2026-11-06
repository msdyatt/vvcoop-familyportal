-- Messaging: one-to-one and group conversations between the adults of the
-- co-op, with photos, plus the report and block tools both app stores require
-- of anything that lets people post to each other.
--
-- Rules, all in SQL so they hold no matter what the client sends:
--   * Adults only. Children have no accounts.
--   * You can message: your own household, a teacher of a class your child is
--     in (and they you), other parents with a child in the same class, other
--     teachers, and administrators. See private.shares_context to change this.
--   * Teachers and administrators can create groups; every class gets a class
--     channel whose members follow enrollments and teaching assignments.
--   * Administrators cannot browse private conversations. They see a message
--     only when someone reports it, with the messages around it for context,
--     and every moderation step is written to audit_log.
--   * Nobody inserts into these tables directly; everything goes through the
--     functions below.

-- --- tables --------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct', 'group', 'class')),
  title text check (title is null or char_length(title) between 1 and 80),
  class_id uuid references public.classes(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  constraint conversations_class_shape check ((kind = 'class') = (class_id is not null)),
  constraint conversations_direct_untitled check (kind <> 'direct' or title is null)
);
create unique index conversations_one_per_class on public.conversations (class_id) where kind = 'class';

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  muted boolean not null default false,
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on public.conversation_members (user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  -- A person's account being deleted leaves their words attributed to "Former member".
  sender_id uuid references public.profiles(id) on delete set null,
  body text check (body is null or char_length(body) <= 4000),
  image_path text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  constraint messages_image_in_conversation check (
    image_path is null or image_path like 'messages/' || conversation_id::text || '/%'),
  constraint messages_has_content check (deleted_at is not null or body is not null or image_path is not null)
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc);

create table public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create table public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  unique (message_id, reporter_id)
);
create index message_reports_open_idx on public.message_reports (created_at) where status = 'open';

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.user_blocks enable row level security;
alter table public.message_reports enable row level security;

-- --- who may see and message whom ------------------------------------------
create or replace function private.is_conversation_member(p_conversation_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select p_conversation_id is not null
    and private.is_active_user()
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = p_conversation_id and m.user_id = (select auth.uid()));
$function$;

create or replace function private.shares_context(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select a is distinct from b
    and exists (select 1 from public.profiles p where p.id = a and p.status = 'active')
    and exists (select 1 from public.profiles p where p.id = b and p.status = 'active')
    and (
      -- anyone can reach an administrator, and they can reach anyone
      exists (select 1 from public.user_roles r where r.user_id in (a, b) and r.role = 'admin')
      -- the same household
      or exists (
        select 1 from public.family_members x join public.family_members y on y.family_id = x.family_id
        where x.user_id = a and y.user_id = b)
      -- two teachers
      or (exists (select 1 from public.user_roles r where r.user_id = a and r.role = 'teacher')
          and exists (select 1 from public.user_roles r where r.user_id = b and r.role = 'teacher'))
      -- a teacher and the adults of a child in their class
      or exists (
        select 1 from public.teacher_assignments ta
        join public.enrollments e on e.class_id = ta.class_id and e.status = 'active'
        join public.children c on c.id = e.child_id
        join public.family_members fm on fm.family_id = c.family_id
        where (ta.user_id = a and fm.user_id = b) or (ta.user_id = b and fm.user_id = a))
      -- two households with a child in the same class
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

create or replace function private.can_message(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.shares_context(a, b)
    and not exists (
      select 1 from public.user_blocks k
      where (k.blocker_id = a and k.blocked_id = b) or (k.blocker_id = b and k.blocked_id = a));
$function$;

-- The people the signed-in user is allowed to start a conversation with. A
-- function rather than a policy on profiles: profile rows carry phone numbers
-- and emergency contacts, which a message recipient has no business seeing.
create or replace function public.messageable_people()
returns table (user_id uuid, display_name text, avatar_path text, is_teacher boolean, is_admin boolean)
language sql stable security definer set search_path to ''
as $function$
  select p.id, coalesce(nullif(p.display_name, ''), 'Member'), p.avatar_path,
    exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'teacher'),
    exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin')
  from public.profiles p
  where private.is_active_user()
    and p.id <> (select auth.uid())
    and private.can_message((select auth.uid()), p.id)
  order by 2;
$function$;

-- --- policies (reads only; every write goes through a function) -------------
create policy conversations_member_read on public.conversations
  for select to authenticated using (private.is_conversation_member(id));

create policy conversation_members_member_read on public.conversation_members
  for select to authenticated using (private.is_conversation_member(conversation_id));

-- A blocked person's messages disappear for the person who blocked them.
create policy messages_member_read on public.messages
  for select to authenticated using (
    private.is_conversation_member(conversation_id)
    and (sender_id is null or not exists (
      select 1 from public.user_blocks b
      where b.blocker_id = (select auth.uid()) and b.blocked_id = messages.sender_id)));

create policy user_blocks_own_read on public.user_blocks
  for select to authenticated using (blocker_id = (select auth.uid()));

create policy message_reports_admin_read on public.message_reports
  for select to authenticated using (private.has_role('admin'));

grant select on public.conversations, public.conversation_members, public.messages,
  public.user_blocks, public.message_reports to authenticated;

-- --- starting conversations -------------------------------------------------
create or replace function public.start_direct_conversation(p_other uuid)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;
  if not private.can_message(v_me, p_other) then
    raise exception 'You can''t message that person.';
  end if;

  select c.id into v_id
  from public.conversations c
  where c.kind = 'direct'
    and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = v_me)
    and exists (select 1 from public.conversation_members m where m.conversation_id = c.id and m.user_id = p_other)
  limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.conversations (kind, created_by) values ('direct', v_me) returning id into v_id;
  insert into public.conversation_members (conversation_id, user_id) values (v_id, v_me), (v_id, p_other);
  return v_id;
end;
$function$;

create or replace function public.create_group_conversation(p_title text, p_members uuid[])
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_id uuid;
  v_member uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not (private.has_role('teacher') or private.has_role('admin')) then
    raise exception 'Only teachers and administrators can start a group.';
  end if;
  if char_length(v_title) not between 1 and 80 then raise exception 'Give the group a name (up to 80 characters).'; end if;
  if coalesce(cardinality(p_members), 0) not between 1 and 50 then raise exception 'A group needs 1 to 50 other people.'; end if;

  foreach v_member in array p_members loop
    if v_member = v_me then continue; end if;
    if not private.can_message(v_me, v_member) then raise exception 'You can''t message everyone you chose.'; end if;
  end loop;

  insert into public.conversations (kind, title, created_by) values ('group', v_title, v_me) returning id into v_id;
  insert into public.conversation_members (conversation_id, user_id)
  select v_id, u from unnest(p_members || v_me) as u group by u;
  return v_id;
end;
$function$;

-- Teachers (and administrators) plus the adults of every child actively enrolled.
create or replace function private.class_conversation_people(p_class_id uuid)
returns setof uuid
language sql stable security definer set search_path to ''
as $function$
  select distinct u from (
    select ta.user_id as u from public.teacher_assignments ta where ta.class_id = p_class_id
    union
    select fm.user_id
    from public.enrollments e
    join public.children c on c.id = e.child_id
    join public.family_members fm on fm.family_id = c.family_id
    where e.class_id = p_class_id and e.status = 'active'
  ) people
  join public.profiles p on p.id = people.u and p.status = 'active';
$function$;

create or replace function private.sync_class_conversation(p_class_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_conv uuid;
begin
  select id into v_conv from public.conversations where kind = 'class' and class_id = p_class_id;
  if v_conv is null then return; end if;

  insert into public.conversation_members (conversation_id, user_id)
  select v_conv, u from private.class_conversation_people(p_class_id) as u
  on conflict do nothing;

  -- Anyone who no longer belongs to the class leaves its channel. An
  -- administrator who joined it on purpose stays, visibly, in the member list.
  delete from public.conversation_members m
  where m.conversation_id = v_conv
    and m.user_id not in (select private.class_conversation_people(p_class_id))
    and not exists (select 1 from public.user_roles r where r.user_id = m.user_id and r.role = 'admin');
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

  select id into v_id from public.conversations where kind = 'class' and class_id = p_class_id;
  if v_id is null then
    insert into public.conversations (kind, title, class_id, created_by)
    values ('class', left(v_title, 80), p_class_id, v_me) returning id into v_id;
  end if;

  perform private.sync_class_conversation(p_class_id);
  -- An administrator opening it joins it, openly.
  if private.has_role('admin') then
    insert into public.conversation_members (conversation_id, user_id) values (v_id, v_me) on conflict do nothing;
  end if;
  return v_id;
end;
$function$;

create or replace function private.sync_class_conversation_trigger()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v_class uuid;
begin
  if tg_op in ('INSERT', 'UPDATE') then v_class := new.class_id; perform private.sync_class_conversation(v_class); end if;
  if tg_op in ('DELETE', 'UPDATE') and (tg_op = 'DELETE' or old.class_id is distinct from new.class_id) then
    perform private.sync_class_conversation(old.class_id);
  end if;
  return null;
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
    where cv.kind = 'class' and c.family_id = v_family
  loop
    perform private.sync_class_conversation(v_class);
  end loop;
  return null;
end;
$function$;

create trigger enrollments_sync_class_conversation
  after insert or update or delete on public.enrollments
  for each row execute function private.sync_class_conversation_trigger();
create trigger teacher_assignments_sync_class_conversation
  after insert or update or delete on public.teacher_assignments
  for each row execute function private.sync_class_conversation_trigger();
create trigger family_members_sync_class_conversations
  after insert or delete on public.family_members
  for each row execute function private.sync_family_conversations_trigger();

-- --- sending, reading, and the small settings --------------------------------
create or replace function public.send_message(p_conversation_id uuid, p_body text default null, p_image_path text default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_kind text;
  v_title text;
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
  v_sender text;
begin
  if not private.is_conversation_member(p_conversation_id) then
    raise exception 'You are not part of that conversation.';
  end if;
  if v_body is null and p_image_path is null then raise exception 'Write a message or add a photo.'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'That message is too long.'; end if;

  select kind, title into v_kind, v_title from public.conversations where id = p_conversation_id;

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

  select coalesce(nullif(display_name, ''), 'A member') into v_sender from public.profiles where id = v_me;

  -- One notification per recipient who has not muted it and has not blocked the
  -- sender; the existing push pipeline turns these into phone notifications.
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select m.user_id, 'message',
    case when v_kind = 'direct' then v_sender else coalesce(v_title, 'Group') || ' · ' || v_sender end,
    case when v_body is not null then left(v_body, 140) else 'Sent a photo' end,
    '/family-village/messages?c=' || p_conversation_id::text, 'conversation', p_conversation_id
  from public.conversation_members m
  join public.profiles p on p.id = m.user_id and p.status = 'active'
  where m.conversation_id = p_conversation_id and m.user_id <> v_me and not m.muted
    and not exists (select 1 from public.user_blocks b where b.blocker_id = m.user_id and b.blocked_id = v_me);

  return v_id;
end;
$function$;

create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.conversation_members set last_read_at = now()
  where conversation_id = p_conversation_id and user_id = (select auth.uid());
  update public.notifications set read_at = now()
  where recipient_user_id = (select auth.uid()) and subject_type = 'conversation'
    and subject_id = p_conversation_id and read_at is null;
end;
$function$;

create or replace function public.set_conversation_muted(p_conversation_id uuid, p_muted boolean)
returns void
language sql security definer set search_path to ''
as $function$
  update public.conversation_members set muted = p_muted
  where conversation_id = p_conversation_id and user_id = (select auth.uid());
$function$;

create or replace function public.leave_conversation(p_conversation_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_kind text;
begin
  select kind into v_kind from public.conversations where id = p_conversation_id;
  if v_kind is distinct from 'group' then
    raise exception 'Only groups can be left. Mute a conversation to stop its notifications.';
  end if;
  delete from public.conversation_members where conversation_id = p_conversation_id and user_id = (select auth.uid());
end;
$function$;

-- The sender removes their own message; the content is erased, not hidden.
-- Returns the photo's path so the app can delete the file as well.
create or replace function public.delete_own_message(p_message_id uuid)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare v_path text;
begin
  select image_path into v_path from public.messages
  where id = p_message_id and sender_id = (select auth.uid()) and deleted_at is null;
  if not found then raise exception 'You can only remove your own messages.'; end if;
  update public.messages
  set body = null, image_path = null, deleted_at = now(), deleted_by = (select auth.uid())
  where id = p_message_id;
  return v_path;
end;
$function$;

create or replace function public.block_user(p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;
  if p_user = (select auth.uid()) then raise exception 'You can''t block yourself.'; end if;
  insert into public.user_blocks (blocker_id, blocked_id) values ((select auth.uid()), p_user) on conflict do nothing;
end;
$function$;

create or replace function public.unblock_user(p_user uuid)
returns void
language sql security definer set search_path to ''
as $function$
  delete from public.user_blocks where blocker_id = (select auth.uid()) and blocked_id = p_user;
$function$;

-- --- listing ----------------------------------------------------------------
create or replace function public.my_conversations()
returns table (
  id uuid, kind text, title text, class_id uuid, last_message_at timestamptz,
  last_preview text, last_sender_name text, unread_count integer, muted boolean,
  member_count integer, other_user_id uuid, other_name text, other_avatar_path text)
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
    oth.user_id, oth.name, oth.avatar_path
  from public.conversations c
  join public.conversation_members me on me.conversation_id = c.id and me.user_id = (select auth.uid())
  left join lateral (
    select case when m.deleted_at is not null then 'Message removed'
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
  select coalesce(sum(unread_count), 0)::int from public.my_conversations() where not muted;
$function$;

-- Names and photos of the other people in a conversation, for message bubbles.
create or replace function public.conversation_people(p_conversation_id uuid)
returns table (user_id uuid, display_name text, avatar_path text, is_teacher boolean, is_admin boolean)
language sql stable security definer set search_path to ''
as $function$
  select p.id, coalesce(nullif(p.display_name, ''), 'Member'), p.avatar_path,
    exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'teacher'),
    exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin')
  from public.conversation_members m join public.profiles p on p.id = m.user_id
  where private.is_conversation_member(p_conversation_id) and m.conversation_id = p_conversation_id;
$function$;

-- --- reports and moderation ---------------------------------------------------
create or replace function public.report_message(p_message_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_conv uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select conversation_id into v_conv from public.messages where id = p_message_id;
  if v_conv is null or not private.is_conversation_member(v_conv) then
    raise exception 'You can only report messages in your own conversations.';
  end if;
  if char_length(v_reason) not between 1 and 500 then raise exception 'Say briefly what is wrong (up to 500 characters).'; end if;

  insert into public.message_reports (message_id, reporter_id, reason)
  values (p_message_id, (select auth.uid()), v_reason) on conflict do nothing;

  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select r.user_id, 'message_report', 'A message was reported', left(v_reason, 140),
    '/family-village/admin', 'message_report', p_message_id
  from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
  where r.role = 'admin' and r.user_id <> (select auth.uid());
end;
$function$;

create or replace function public.admin_message_reports()
returns table (
  id uuid, message_id uuid, status text, reason text, created_at timestamptz,
  reporter_name text, sender_name text, conversation_title text, conversation_kind text,
  body text, image_path text, message_deleted boolean)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  return query
  select r.id, r.message_id, r.status, r.reason, r.created_at,
    coalesce(nullif(rp.display_name, ''), 'Former member'),
    coalesce(nullif(sp.display_name, ''), 'Former member'),
    coalesce(c.title, 'Direct message'), c.kind,
    m.body, m.image_path, m.deleted_at is not null
  from public.message_reports r
  join public.messages m on m.id = r.message_id
  join public.conversations c on c.id = m.conversation_id
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.profiles sp on sp.id = m.sender_id
  order by (r.status = 'open') desc, r.created_at desc
  limit 200;
end;
$function$;

-- The reported message and up to three on either side, so a report can be
-- judged in context. This is the only way an administrator reads a private
-- conversation, and it is logged.
create or replace function public.admin_report_context(p_report_id uuid)
returns table (id uuid, sender_name text, body text, image_path text, created_at timestamptz, is_reported boolean, deleted boolean)
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
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, m.id = v_msg, m.deleted_at is not null
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.conversation_id = v_conv and m.created_at < v_at order by m.created_at desc limit 3)
    union all
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, m.id = v_msg, m.deleted_at is not null
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.id = v_msg)
    union all
    (select m.id, coalesce(nullif(p.display_name, ''), 'Former member'), m.body, m.image_path, m.created_at, false, m.deleted_at is not null
     from public.messages m left join public.profiles p on p.id = m.sender_id
     where m.conversation_id = v_conv and m.created_at > v_at order by m.created_at asc limit 3)
  ) ctx order by 5;
end;
$function$;

create or replace function public.resolve_message_report(p_report_id uuid, p_action text, p_note text default null)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare v_msg uuid; v_path text;
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  if p_action not in ('remove', 'dismiss') then raise exception 'Choose remove or dismiss.'; end if;
  select message_id into v_msg from public.message_reports where id = p_report_id;
  if v_msg is null then raise exception 'That report does not exist.'; end if;

  if p_action = 'remove' then
    select image_path into v_path from public.messages where id = v_msg;
    update public.messages
    set body = null, image_path = null, deleted_at = coalesce(deleted_at, now()), deleted_by = (select auth.uid())
    where id = v_msg;
  end if;

  update public.message_reports
  set status = case when p_action = 'remove' then 'actioned' else 'dismissed' end,
      resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(p_note, 500)
  where message_id = v_msg and status = 'open';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), 'message_report_' || p_action, 'message', v_msg::text, jsonb_build_object('report_id', p_report_id));

  -- The caller deletes the photo file (if any) through the storage API.
  return v_path;
end;
$function$;

-- --- photo files ---------------------------------------------------------------
-- Photos live in the existing private bucket under messages/<conversation id>/.
-- Anyone in that conversation can read and add; only the uploader can delete.
create or replace function private.message_path_conversation(p_name text)
returns uuid
language plpgsql immutable set search_path to ''
as $function$
begin
  if p_name like 'messages/%/%' then
    return split_part(p_name, '/', 2)::uuid;
  end if;
  return null;
exception when invalid_text_representation then
  return null;
end;
$function$;

create policy messages_photo_read on storage.objects
  for select to authenticated
  using (bucket_id = 'family-village-private' and name like 'messages/%'
         and private.is_conversation_member(private.message_path_conversation(name)));

create policy messages_photo_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'family-village-private' and name like 'messages/%'
         and private.is_conversation_member(private.message_path_conversation(name)));

create policy messages_photo_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'family-village-private' and name like 'messages/%'
         and owner_id = (select auth.uid())::text);

-- An administrator who removes a reported message can remove its photo file too.
create policy messages_photo_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'family-village-private' and name like 'messages/%' and private.has_role('admin'));

-- --- live updates and grants -------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

revoke all on function private.sync_class_conversation(uuid) from public, anon, authenticated;
revoke all on function private.class_conversation_people(uuid) from public, anon, authenticated;
revoke all on function private.sync_class_conversation_trigger() from public, anon, authenticated;
revoke all on function private.sync_family_conversations_trigger() from public, anon, authenticated;

revoke all on function public.messageable_people() from public, anon;
revoke all on function public.start_direct_conversation(uuid) from public, anon;
revoke all on function public.create_group_conversation(text, uuid[]) from public, anon;
revoke all on function public.open_class_conversation(uuid) from public, anon;
revoke all on function public.send_message(uuid, text, text) from public, anon;
revoke all on function public.mark_conversation_read(uuid) from public, anon;
revoke all on function public.set_conversation_muted(uuid, boolean) from public, anon;
revoke all on function public.leave_conversation(uuid) from public, anon;
revoke all on function public.delete_own_message(uuid) from public, anon;
revoke all on function public.block_user(uuid) from public, anon;
revoke all on function public.unblock_user(uuid) from public, anon;
revoke all on function public.my_conversations() from public, anon;
revoke all on function public.unread_message_count() from public, anon;
revoke all on function public.conversation_people(uuid) from public, anon;
revoke all on function public.report_message(uuid, text) from public, anon;
revoke all on function public.admin_message_reports() from public, anon;
revoke all on function public.admin_report_context(uuid) from public, anon;
revoke all on function public.resolve_message_report(uuid, text, text) from public, anon;

grant execute on function public.messageable_people() to authenticated;
grant execute on function public.start_direct_conversation(uuid) to authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
grant execute on function public.open_class_conversation(uuid) to authenticated;
grant execute on function public.send_message(uuid, text, text) to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
grant execute on function public.set_conversation_muted(uuid, boolean) to authenticated;
grant execute on function public.leave_conversation(uuid) to authenticated;
grant execute on function public.delete_own_message(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.my_conversations() to authenticated;
grant execute on function public.unread_message_count() to authenticated;
grant execute on function public.conversation_people(uuid) to authenticated;
grant execute on function public.report_message(uuid, text) to authenticated;
grant execute on function public.admin_message_reports() to authenticated;
grant execute on function public.admin_report_context(uuid) to authenticated;
grant execute on function public.resolve_message_report(uuid, text, text) to authenticated;
