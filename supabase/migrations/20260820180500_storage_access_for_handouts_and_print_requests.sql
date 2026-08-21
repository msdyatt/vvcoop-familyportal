-- Teachers need to upload class handouts and print-queue files; admin
-- upload/read was already covered by the existing bucket-wide admin policies.
create policy family_documents_teacher_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'family-village-private'
  and private.has_role('teacher')
  and (name like 'handouts/%' or name like 'print-requests/%')
);

-- News photos are meant to be visible to any signed-in, active member.
create policy family_documents_news_read on storage.objects for select to authenticated using (
  bucket_id = 'family-village-private' and name like 'news/%' and private.is_active_user()
);

-- Handouts are readable by the teaching team for that class, or a family
-- whose enrolled child is in that class.
create policy family_documents_handout_read on storage.objects for select to authenticated using (
  bucket_id = 'family-village-private' and name like 'handouts/%' and (
    private.has_role('admin')
    or exists (
      select 1 from public.documents d
      where d.storage_path = objects.name and d.class_id is not null
        and (private.teaches_class(d.class_id) or private.has_class_family_access(d.class_id))
    )
  )
);

-- A print request's file is only readable by the teacher who sent it, or an admin fulfilling it.
create policy family_documents_print_read on storage.objects for select to authenticated using (
  bucket_id = 'family-village-private' and name like 'print-requests/%' and (
    private.has_role('admin')
    or exists (select 1 from public.print_requests p where p.storage_path = objects.name and p.requested_by_user_id = (select auth.uid()))
  )
);
