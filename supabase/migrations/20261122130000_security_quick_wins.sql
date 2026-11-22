-- Security fixes from the November 2026 bug bash (issues #126, #163, #166, #167).
--
-- 1. Notifications belong to their recipient (#126). notifications_admin_all let
--    every administrator read and update every person's notifications, so an
--    admin's bell listed the rows written for each person they messaged (with a
--    preview of the message), and "Mark all read" marked other people's
--    notifications read, which skipped their email fallback. No screen needs
--    it: admin tooling goes through SECURITY DEFINER functions. The update
--    guard no longer lets an admin change more than read_at on their own rows.
--    A broadcast also no longer goes to the person who sent it.
-- 2. News post notifications stay inside their world (#163): a demo post
--    notifies nobody, and a real post never notifies a reviewer account.
-- 3. Photos and albums created by a reviewer account are demo content, and
--    their approval requests only reach approvers in the same world (#166).
-- 4. Admin, Classes can save again: UPDATE on classes.subject (#167).

-- --- 1. notifications ----------------------------------------------------------------------
drop policy if exists notifications_admin_all on public.notifications;

-- notifications_read and notifications_self_update already limit select and
-- update to the recipient. Nothing outside SECURITY DEFINER functions inserts
-- or deletes notifications, so signed-in users keep only select and update.
revoke insert, delete on public.notifications from authenticated;

create or replace function private.restrict_notification_self_update()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  -- Same rule for everyone, administrators included: a person may only mark
  -- their own notification read. SECURITY DEFINER functions that set read_at
  -- or push_opened_at pass this check because those columns are not fenced.
  if new.recipient_user_id is distinct from old.recipient_user_id
    or new.kind is distinct from old.kind
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.link_path is distinct from old.link_path
    or new.subject_type is distinct from old.subject_type
    or new.subject_id is distinct from old.subject_id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'A recipient may only mark a notification read.';
  end if;
  return new;
end;
$$;

-- Same as 20261113120000_broadcasts.sql, plus "not the sender".
create or replace function private.broadcast_audience(p_audience jsonb, p_sender uuid, p_severity text)
returns table (user_id uuid)
language plpgsql stable security definer set search_path to ''
as $function$
declare v_type text := p_audience ->> 'type'; v_ids uuid[];
begin
  if v_type = 'everyone' then
    select coalesce(array_agg(p.id), '{}') into v_ids from public.profiles p;
  elsif v_type = 'teachers' then
    select coalesce(array_agg(distinct r.user_id), '{}') into v_ids from public.user_roles r where r.role = 'teacher';
  elsif v_type = 'class' then
    select coalesce(array_agg(x.u), '{}') into v_ids from (
      select ta.user_id as u from public.teacher_assignments ta where ta.class_id = (p_audience ->> 'class_id')::uuid
      union
      select fm.user_id from public.enrollments e
        join public.children c on c.id = e.child_id and c.active
        join public.family_members fm on fm.family_id = c.family_id
      where e.class_id = (p_audience ->> 'class_id')::uuid and e.status = 'active') x;
  elsif v_type = 'grade' then
    select coalesce(array_agg(distinct fm.user_id), '{}') into v_ids
    from public.children c join public.family_members fm on fm.family_id = c.family_id
    where c.active and c.age_band = (p_audience ->> 'grade');
  elsif v_type = 'people' then
    select coalesce(array_agg(distinct x::uuid), '{}') into v_ids from jsonb_array_elements_text(coalesce(p_audience -> 'user_ids', '[]'::jsonb)) x;
  else
    raise exception 'Choose who should receive this.';
  end if;

  return query
  select p.id from public.profiles p
  where p.id = any (v_ids)
    and p.id is distinct from p_sender
    and p.status = 'active' and not p.is_demo and lower(p.email) not like '%@demo.veritasvillage.org'
    and (p_severity = 'urgent' or p_sender is null
         or not exists (select 1 from public.user_blocks b where b.blocker_id = p.id and b.blocked_id = p_sender));
end;
$function$;

-- --- 2. news post notifications --------------------------------------------------------------
-- Same as 20261116100000_scheduled_announcements.sql, plus the demo checks.
create or replace function private.notify_post_published()
returns trigger
language plpgsql security definer set search_path to ''
as $$
begin
  if new.published_at is null then return null; end if;
  if tg_op = 'UPDATE' and old.published_at is not null then return null; end if;  -- first publication only
  -- Demo (reviewer) posts are sample content created by seed_demo_data; they notify nobody.
  if new.is_demo then return null; end if;

  if new.audience in ('public', 'families') then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select p.id, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from public.profiles p
    where p.status = 'active' and p.id is distinct from new.author_user_id
      and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org';

  elsif new.audience = 'teachers' then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct r.user_id, 'post_published', new.title, left(new.body, 200), '/family-village/teacher', 'post', new.id
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.role = 'teacher' and p.status = 'active' and p.id is distinct from new.author_user_id
      and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org';

  elsif new.audience = 'class' and new.class_id is not null then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select distinct recipient, 'post_published', new.title, left(new.body, 200), '/family-village/home', 'post', new.id
    from (
      select ta.user_id as recipient
      from public.teacher_assignments ta
      where ta.class_id = new.class_id
      union
      select fm.user_id as recipient
      from public.enrollments e
      join public.children c on c.id = e.child_id
      join public.family_members fm on fm.family_id = c.family_id
      where e.class_id = new.class_id
    ) recipients
    join public.profiles p on p.id = recipients.recipient
    where p.status = 'active' and p.id is distinct from new.author_user_id
      and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org';
  end if;

  return null;
end;
$$;

-- Notifications that already crossed the boundary: a demo post's notice in a
-- real person's bell, or a real post's notice in a reviewer account's bell.
delete from public.notifications n
using public.posts po, public.profiles p
where n.kind = 'post_published' and n.subject_type = 'post' and n.subject_id = po.id
  and p.id = n.recipient_user_id
  and po.is_demo is distinct from p.is_demo;

-- --- 3. photos and albums ----------------------------------------------------------------------
-- Same as 20261106200000_photo_library.sql, plus is_demo from the caller.
create or replace function public.create_album(p_title text, p_class_id uuid default null, p_school_year_id uuid default null, p_event_on date default null)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid; v_title text := btrim(coalesce(p_title, ''));
begin
  if char_length(v_title) not between 1 and 100 then raise exception 'Give the album a name (up to 100 characters).'; end if;
  if not (private.has_role('admin') or private.has_role('teacher')) then
    raise exception 'Only teachers and administrators can create albums.';
  end if;
  if p_class_id is not null and not (private.has_role('admin') or private.teaches_class(p_class_id)) then
    raise exception 'You can only create albums for classes you teach.';
  end if;
  insert into public.photo_albums (title, class_id, school_year_id, event_on, created_by, is_demo)
  values (v_title,
    p_class_id,
    coalesce(p_school_year_id, (select c.school_year_id from public.classes c where c.id = p_class_id),
             (select y.id from public.school_years y where y.is_current limit 1)),
    p_event_on, (select auth.uid()), private.is_demo_user())
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.add_photo(
  p_id uuid, p_visibility text, p_class_id uuid default null, p_album_id uuid default null,
  p_caption text default null, p_taken_on date default null, p_confirmed boolean default false)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_demo boolean := private.is_demo_user();
  v_staff boolean := private.has_role('admin') or private.has_role('teacher');
  v_status text;
  v_year uuid;
  v_class uuid := p_class_id;
  v_album public.photo_albums;
begin
  if not private.is_active_user() then raise exception 'Sign in first.'; end if;
  if not coalesce(p_confirmed, false) then raise exception 'Please confirm you have permission to share this photo.'; end if;
  if p_visibility not in ('coop', 'class') then raise exception 'Choose who can see this photo.'; end if;
  if p_visibility = 'class' and v_class is null then raise exception 'Choose a class for a class-only photo.'; end if;

  if exists (select 1 from public.photos where id = p_id) then raise exception 'That photo was already added.'; end if;
  if p_album_id is not null then
    select * into v_album from public.photo_albums where id = p_album_id;
    -- An album from the other world (demo or real) does not exist as far as the caller is concerned.
    if v_album.id is null or v_album.is_demo is distinct from v_demo then raise exception 'That album does not exist.'; end if;
    if v_album.class_id is not null and not private.can_see_class_media(v_album.class_id) then
      raise exception 'You can''t add to that album.';
    end if;
  end if;

  -- Filing under a class (and sharing to it) is for people who belong to it.
  if v_class is not null and not private.can_see_class_media(v_class) then
    raise exception 'You can only use a class you teach or have a child in.';
  end if;

  if (select count(*) from storage.objects where bucket_id = 'family-village-private'
        and name in ('library/' || p_id::text || '/full.jpg', 'library/' || p_id::text || '/thumb.jpg')) <> 2 then
    raise exception 'The photo files are missing. Please try uploading again.';
  end if;

  -- Staff publish straight away; everyone else waits for approval.
  v_status := case when v_staff and (p_visibility = 'coop' or private.has_role('admin') or private.teaches_class(v_class)) then 'published' else 'pending' end;

  v_year := coalesce(v_album.school_year_id, (select c.school_year_id from public.classes c where c.id = v_class),
                     (select y.id from public.school_years y where y.is_current limit 1));

  insert into public.photos (id, album_id, storage_path, thumb_path, caption, visibility, class_id, school_year_id, taken_on, status, uploaded_by, approved_by, approved_at, is_demo)
  values (p_id, p_album_id, 'library/' || p_id::text || '/full.jpg', 'library/' || p_id::text || '/thumb.jpg',
          nullif(btrim(coalesce(p_caption, '')), ''), p_visibility, v_class, v_year, p_taken_on, v_status, v_me,
          case when v_status = 'published' then v_me end, case when v_status = 'published' then now() end, v_demo);

  if v_status = 'pending' then
    -- Approvers in the uploader's own world only: a reviewer's submission never reaches a real
    -- administrator, and a real one never reaches a reviewer account.
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select u, 'photo_submitted', 'A photo is waiting for approval', left(coalesce(nullif(btrim(p_caption), ''), 'New photo submitted'), 140),
           '/family-village/photos?review=1', 'photo', p_id
    from (
      select r.user_id as u from public.user_roles r where r.role = 'admin'
      union
      select ta.user_id from public.teacher_assignments ta where v_class is not null and ta.class_id = v_class
    ) approvers join public.profiles p on p.id = approvers.u and p.status = 'active'
    where approvers.u <> v_me
      and p.is_demo = v_demo
      and (v_demo or lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org');
  end if;
  return v_status;
end;
$function$;

revoke all on function public.create_album(text, uuid, uuid, date) from public, anon;
revoke all on function public.add_photo(uuid, text, uuid, uuid, text, date, boolean) from public, anon;
grant execute on function public.create_album(text, uuid, uuid, date) to authenticated;
grant execute on function public.add_photo(uuid, text, uuid, uuid, text, date, boolean) to authenticated;

-- --- 4. classes.subject ---------------------------------------------------------------------------
-- 20261114100000_grade_based_placement.sql added classes.subject, but UPDATE on
-- public.classes is granted per column (20260827121652_class_calendar_token.sql)
-- and subject was never added. Admin, Classes, Save always sends it, so every
-- class edit failed with "permission denied for table classes". Same shape as
-- 20261105082033_grant_update_classes_capacity.sql. GRANT UPDATE (col) is additive.
grant update (subject) on public.classes to authenticated;
