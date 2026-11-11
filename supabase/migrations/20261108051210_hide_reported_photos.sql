-- A photo with an open report is hidden from the library until an administrator has reviewed it.
--
-- Until now a report only told the administrators; the photo stayed in front of
-- everyone while they got round to it. Now the moment someone reports a photo,
-- nobody but an administrator can see it (not the person who reported it, not
-- the uploader, not other members). If the administrator dismisses the report,
-- it comes straight back; if they remove it, it is deleted, as before. Another
-- open report on the same photo keeps it hidden until that one is settled too.
--
-- Files follow the photo: reading a library file already requires being able to
-- read its photo row (library_photo_read), so a direct link to a hidden photo
-- stops working for the same people.

-- photo_reports can only be read by administrators, so a policy cannot look at it
-- under the reader's own rights. This answers one narrow question and nothing else.
create or replace function private.photo_under_review(p_photo_id uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.photo_reports r where r.photo_id = p_photo_id and r.status = 'open');
$function$;

revoke all on function private.photo_under_review(uuid) from public, anon;
grant execute on function private.photo_under_review(uuid) to authenticated;

create index if not exists photo_reports_open_idx on public.photo_reports (photo_id) where status = 'open';

drop policy photos_read on public.photos;
create policy photos_read on public.photos
  for select to authenticated using (
    private.is_active_user() and (
      private.has_role('admin')
      or (not private.photo_under_review(id) and (
        uploaded_by = (select auth.uid())
        or (status = 'published' and (visibility = 'coop' or private.can_see_class_media(class_id)))
        or (status = 'pending' and visibility = 'class' and private.teaches_class(class_id))))));
