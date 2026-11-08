-- Lets an administrator delete profile and child photos from storage.
--
-- Photos are replaced rather than edited (each upload gets a new file name), so
-- the old file is left behind. The "make photos smaller" tool in the admin
-- Integrations tab swaps oversized originals for small ones and then removes the
-- originals, which needs this. Only administrators, only under avatars/.
create policy avatar_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'family-village-private' and name like 'avatars/%' and private.has_role('admin'));
