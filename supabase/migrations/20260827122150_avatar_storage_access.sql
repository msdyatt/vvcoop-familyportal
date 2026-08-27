-- QA finding VV-11: account-settings.tsx offers every signed-in user a
-- "change photo" upload to avatars/<uuid>-<filename>, but no storage.objects
-- policy allowed it -- only family_documents_admin_upload (any path, admin
-- only) and family_documents_teacher_upload (handouts/print-requests only,
-- teacher only) existed. A regular parent's own avatar upload has been
-- failing outright.
--
-- Confirmed the read side was broken too, not just uploads: none of the four
-- existing SELECT policies cover an avatars/ path either (family_documents_
-- download only matches rows in the `documents` table, which avatars never
-- are), so even an admin-uploaded avatar was invisible to anyone but an
-- admin -- verified in a rolled-back transaction as a real non-admin user
-- (0 visible rows under avatars/, though rows exist there).
--
-- Scoped the same way family_documents_news_read already is (any active
-- signed-in member, no further per-viewer restriction): a profile picture is
-- low-sensitivity content shown across the app to many different kinds of
-- viewer (family cards, teacher directory, the account header), and
-- reproducing "who is allowed to see whose photo" as a storage policy would
-- mean re-deriving business logic this project already keeps in RLS on the
-- actual tables, for content that doesn't need it.
create policy family_documents_avatar_read on storage.objects
  for select to authenticated
  using (bucket_id = 'family-village-private' and name like 'avatars/%' and private.is_active_user());

create policy family_documents_avatar_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'family-village-private' and name like 'avatars/%' and private.is_active_user());
