-- Shared photo library, stored here instead of on Facebook.
--
-- Albums group photos; a photo can belong to a class, a school year, an album,
-- and has a caption and a date taken. Filtering by class, year, album and
-- caption is done by the app with ordinary queries; row-level security decides
-- which photos each person can see.
--
-- Who does what:
--   * Teachers and administrators publish directly. A teacher can publish to a
--     class they teach, or to the whole co-op.
--   * Any other adult (a parent) submits a photo; it stays pending until an
--     administrator, or a teacher of that class, approves it.
--   * Each photo is visible to the whole co-op, or to one class (its teachers,
--     the families with an enrolled child, and administrators).
--   * Photos are not tagged with children and carry no per-child consent step;
--     the uploader confirms they have permission to share. Anyone who can see a
--     photo can report it, and administrators can remove it.
--
-- Files are stored in the private bucket as library/<photo id>/full.jpg and
-- thumb.jpg. The app resizes and strips location data before uploading.

create table public.photo_albums (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 100),
  class_id uuid references public.classes(id) on delete set null,
  school_year_id uuid references public.school_years(id) on delete set null,
  event_on date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index photo_albums_class_idx on public.photo_albums (class_id);

create table public.photos (
  id uuid primary key,
  album_id uuid references public.photo_albums(id) on delete set null,
  storage_path text not null,
  thumb_path text not null,
  caption text check (caption is null or char_length(caption) <= 300),
  visibility text not null check (visibility in ('coop', 'class')),
  class_id uuid references public.classes(id) on delete set null,
  school_year_id uuid references public.school_years(id) on delete set null,
  taken_on date,
  status text not null default 'published' check (status in ('pending', 'published')),
  uploaded_by uuid references public.profiles(id) on delete set null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint photos_class_visibility check (visibility <> 'class' or class_id is not null)
);
create index photos_class_idx on public.photos (class_id);
create index photos_year_idx on public.photos (school_year_id);
create index photos_album_idx on public.photos (album_id);
create index photos_sort_idx on public.photos (taken_on desc nulls last, created_at desc);
create index photos_pending_idx on public.photos (created_at) where status = 'pending';

create table public.photo_reports (
  id uuid primary key default gen_random_uuid(),
  photo_id uuid not null references public.photos(id) on delete cascade,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  unique (photo_id, reporter_id)
);

alter table public.photo_albums enable row level security;
alter table public.photos enable row level security;
alter table public.photo_reports enable row level security;

-- --- visibility ----------------------------------------------------------------
-- Same people the old media policy named: administrators, the class's teachers,
-- and the families of children actively enrolled in it.
create or replace function private.can_see_class_media(p_class_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select p_class_id is not null and private.is_active_user() and (
    private.has_role('admin')
    or private.teaches_class(p_class_id)
    or exists (
      select 1 from public.enrollments e join public.children c on c.id = e.child_id
      where e.class_id = p_class_id and e.status = 'active' and private.has_family_access(c.family_id)));
$function$;

create policy photos_read on public.photos
  for select to authenticated using (
    private.is_active_user() and (
      uploaded_by = (select auth.uid())
      or private.has_role('admin')
      or (status = 'published' and (visibility = 'coop' or private.can_see_class_media(class_id)))
      or (status = 'pending' and visibility = 'class' and private.teaches_class(class_id))));

create policy photo_albums_read on public.photo_albums
  for select to authenticated using (
    private.is_active_user() and (class_id is null or private.can_see_class_media(class_id)));

create policy photo_reports_admin_read on public.photo_reports
  for select to authenticated using (private.has_role('admin'));

grant select on public.photo_albums, public.photos, public.photo_reports to authenticated;

-- --- who may publish, approve and remove --------------------------------------
create or replace function private.can_manage_photo(p_uploaded_by uuid, p_visibility text, p_class_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.has_role('admin')
    or (p_class_id is not null and private.teaches_class(p_class_id))
    or p_uploaded_by = (select auth.uid());
$function$;

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
  insert into public.photo_albums (title, class_id, school_year_id, event_on, created_by)
  values (v_title,
    p_class_id,
    coalesce(p_school_year_id, (select c.school_year_id from public.classes c where c.id = p_class_id),
             (select y.id from public.school_years y where y.is_current limit 1)),
    p_event_on, (select auth.uid()))
  returning id into v_id;
  return v_id;
end;
$function$;

-- Register an uploaded photo. The files must already be in storage; their
-- paths are set here, never taken from the caller.
create or replace function public.add_photo(
  p_id uuid, p_visibility text, p_class_id uuid default null, p_album_id uuid default null,
  p_caption text default null, p_taken_on date default null, p_confirmed boolean default false)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
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
    if v_album.id is null then raise exception 'That album does not exist.'; end if;
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

  insert into public.photos (id, album_id, storage_path, thumb_path, caption, visibility, class_id, school_year_id, taken_on, status, uploaded_by, approved_by, approved_at)
  values (p_id, p_album_id, 'library/' || p_id::text || '/full.jpg', 'library/' || p_id::text || '/thumb.jpg',
          nullif(btrim(coalesce(p_caption, '')), ''), p_visibility, v_class, v_year, p_taken_on, v_status, v_me,
          case when v_status = 'published' then v_me end, case when v_status = 'published' then now() end);

  if v_status = 'pending' then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select u, 'photo_submitted', 'A photo is waiting for approval', left(coalesce(nullif(btrim(p_caption), ''), 'New photo submitted'), 140),
           '/family-village/photos?review=1', 'photo', p_id
    from (
      select r.user_id as u from public.user_roles r where r.role = 'admin'
      union
      select ta.user_id from public.teacher_assignments ta where v_class is not null and ta.class_id = v_class
    ) approvers join public.profiles p on p.id = approvers.u and p.status = 'active'
    where approvers.u <> v_me;
  end if;
  return v_status;
end;
$function$;

create or replace function public.approve_photo(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v public.photos;
begin
  select * into v from public.photos where id = p_id and status = 'pending';
  if v.id is null then raise exception 'That photo is not waiting for approval.'; end if;
  if not (private.has_role('admin') or (v.class_id is not null and private.teaches_class(v.class_id))) then
    raise exception 'Only an administrator or a teacher of the class can approve it.';
  end if;
  update public.photos set status = 'published', approved_by = (select auth.uid()), approved_at = now() where id = p_id;
  if v.uploaded_by is not null and v.uploaded_by <> (select auth.uid()) then
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    values (v.uploaded_by, 'photo_approved', 'Your photo was added to the library', coalesce(left(v.caption, 140), ''), '/family-village/photos', 'photo', p_id);
  end if;
end;
$function$;

-- Remove a photo. Returns its file paths so the app can delete the files too.
create or replace function public.delete_photo(p_id uuid)
returns text[]
language plpgsql security definer set search_path to ''
as $function$
declare v public.photos;
begin
  select * into v from public.photos where id = p_id;
  if v.id is null then raise exception 'That photo does not exist.'; end if;
  if not private.can_manage_photo(v.uploaded_by, v.visibility, v.class_id) then
    raise exception 'You can only remove your own photos, or photos in a class you teach.';
  end if;
  delete from public.photos where id = p_id;
  if v.uploaded_by is distinct from (select auth.uid()) then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values ((select auth.uid()), 'photo_removed', 'photo', p_id::text, jsonb_build_object('uploaded_by', v.uploaded_by));
  end if;
  return array[v.storage_path, v.thumb_path];
end;
$function$;

create or replace function public.update_photo(p_id uuid, p_caption text, p_album_id uuid, p_taken_on date)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v public.photos;
begin
  select * into v from public.photos where id = p_id;
  if v.id is null or not private.can_manage_photo(v.uploaded_by, v.visibility, v.class_id) then
    raise exception 'You can only edit your own photos, or photos in a class you teach.';
  end if;
  if p_album_id is not null and not exists (select 1 from public.photo_albums a where a.id = p_album_id) then
    raise exception 'That album does not exist.';
  end if;
  update public.photos
  set caption = nullif(btrim(coalesce(p_caption, '')), ''), album_id = p_album_id, taken_on = p_taken_on
  where id = p_id;
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

  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select r.user_id, 'photo_report', 'A photo was reported', left(v_reason, 140), '/family-village/admin', 'photo_report', p_id
  from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
  where r.role = 'admin' and r.user_id <> (select auth.uid());
end;
$function$;

create or replace function public.admin_photo_reports()
returns table (id uuid, photo_id uuid, status text, reason text, created_at timestamptz,
  reporter_name text, uploader_name text, caption text, class_title text, thumb_path text, storage_path text)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  return query
  select r.id, r.photo_id, r.status, r.reason, r.created_at,
    coalesce(nullif(rp.display_name, ''), 'Former member'), coalesce(nullif(up.display_name, ''), 'Former member'),
    ph.caption, c.title, ph.thumb_path, ph.storage_path
  from public.photo_reports r
  join public.photos ph on ph.id = r.photo_id
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.profiles up on up.id = ph.uploaded_by
  left join public.classes c on c.id = ph.class_id
  order by (r.status = 'open') desc, r.created_at desc
  limit 200;
end;
$function$;

create or replace function public.resolve_photo_report(p_report_id uuid, p_action text)
returns text[]
language plpgsql security definer set search_path to ''
as $function$
declare v_photo uuid; v_paths text[];
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.'; end if;
  if p_action not in ('remove', 'dismiss') then raise exception 'Choose remove or dismiss.'; end if;
  select photo_id into v_photo from public.photo_reports where id = p_report_id;
  if v_photo is null then raise exception 'That report does not exist.'; end if;

  if p_action = 'remove' then
    select array[storage_path, thumb_path] into v_paths from public.photos where id = v_photo;
    -- Deleting the photo deletes its reports with it; log first.
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values ((select auth.uid()), 'photo_report_remove', 'photo', v_photo::text, jsonb_build_object('report_id', p_report_id));
    delete from public.photos where id = v_photo;
  else
    update public.photo_reports set status = 'dismissed', resolved_by = (select auth.uid()), resolved_at = now() where id = p_report_id;
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values ((select auth.uid()), 'photo_report_dismiss', 'photo', v_photo::text, jsonb_build_object('report_id', p_report_id));
  end if;
  return v_paths;
end;
$function$;

-- --- files ---------------------------------------------------------------------
create or replace function private.library_path_photo(p_name text)
returns uuid
language plpgsql immutable set search_path to ''
as $function$
begin
  if p_name like 'library/%/%' then return split_part(p_name, '/', 2)::uuid; end if;
  return null;
exception when invalid_text_representation then
  return null;
end;
$function$;

-- Any active member can upload (a parent submitting a photo needs to); the
-- photo only becomes visible to others once add_photo registers it.
create policy library_photo_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'family-village-private' and name like 'library/%'
              and private.is_active_user() and private.library_path_photo(name) is not null
              and name ~ '^library/[0-9a-f-]{36}/(full|thumb)\.jpg$');

-- Reading a file follows reading its photo: the subquery runs under the
-- reader's own row-level security on public.photos.
create policy library_photo_read on storage.objects
  for select to authenticated
  using (bucket_id = 'family-village-private' and name like 'library/%'
         and exists (select 1 from public.photos p where p.id = private.library_path_photo(name)));

create policy library_photo_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'family-village-private' and name like 'library/%'
         and (private.has_role('admin') or private.has_role('teacher') or owner_id = (select auth.uid())::text));

-- can_see_class_media and library_path_photo are called from row-level security
-- policies, which run as the signed-in user, so they must stay executable by
-- that role (the private schema is not exposed through the API). can_manage_photo
-- is only called from the functions below, which run as their owner.
revoke all on function private.can_manage_photo(uuid, text, uuid) from public, anon, authenticated;

revoke all on function public.create_album(text, uuid, uuid, date) from public, anon;
revoke all on function public.add_photo(uuid, text, uuid, uuid, text, date, boolean) from public, anon;
revoke all on function public.approve_photo(uuid) from public, anon;
revoke all on function public.delete_photo(uuid) from public, anon;
revoke all on function public.update_photo(uuid, text, uuid, date) from public, anon;
revoke all on function public.report_photo(uuid, text) from public, anon;
revoke all on function public.admin_photo_reports() from public, anon;
revoke all on function public.resolve_photo_report(uuid, text) from public, anon;

grant execute on function public.create_album(text, uuid, uuid, date) to authenticated;
grant execute on function public.add_photo(uuid, text, uuid, uuid, text, date, boolean) to authenticated;
grant execute on function public.approve_photo(uuid) to authenticated;
grant execute on function public.delete_photo(uuid) to authenticated;
grant execute on function public.update_photo(uuid, text, uuid, date) to authenticated;
grant execute on function public.report_photo(uuid, text) to authenticated;
grant execute on function public.admin_photo_reports() to authenticated;
grant execute on function public.resolve_photo_report(uuid, text) to authenticated;
