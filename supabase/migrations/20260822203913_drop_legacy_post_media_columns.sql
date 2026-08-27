-- Retire the single-image columns on posts
-- ---------------------------------------------------------------------------
-- posts.image_storage_path held one photo per post; its values were copied into
-- post_attachments in the previous migration and the application now reads only
-- that table. attachment_url and video_url were never written by anything.
--
-- Verified before dropping: every non-null image_storage_path has a matching
-- post_attachments row, and no code references any of the three columns.
-- ---------------------------------------------------------------------------

do $$
declare unmigrated int;
begin
  select count(*) into unmigrated
  from public.posts p
  where p.image_storage_path is not null
    and not exists (
      select 1 from public.post_attachments a
      where a.post_id = p.id and a.storage_path = p.image_storage_path
    );
  if unmigrated > 0 then
    raise exception 'Refusing to drop: % post image(s) were never copied into post_attachments', unmigrated;
  end if;
end $$;

alter table public.posts
  drop column if exists image_storage_path,
  drop column if exists attachment_url,
  drop column if exists video_url;
