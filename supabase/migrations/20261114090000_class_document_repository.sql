-- The class document repository: who may read, add and remove a class's files.
-- ---------------------------------------------------------------------------
-- A class's files are `documents` rows with a class_id. kind 'handout' is for the
-- teaching team and the families of enrolled children; kind 'curriculum' is a
-- teaching-team working file. Three things in the rules did not match that:
--
--   1. Curriculum was hidden from parents at the row level (20260825051802) but
--      not at the storage level. The handout read policy on storage.objects only
--      asks "do you teach this class, or is your child enrolled in it" and never
--      looks at the kind, so a parent who had the path of a curriculum file could
--      still download it. The path is a random id and no parent is shown it, so
--      this was not reachable from the app, but the rule belongs on the file too.
--      Tightened: a family may read a handout's file, never a curriculum file.
--
--   2. Only the person who uploaded a file could remove it. A second lead teacher
--      could not remove the first one's file, a teacher who left (their account
--      deleted: uploaded_by_user_id becomes null) left files nobody but an admin
--      could remove, and a lead who was later moved to assistant could still
--      remove what they had uploaded. Removal now follows the role: the lead
--      teachers of the class and administrators. Documents that are not in a
--      class (a family's papers) keep the old rule exactly.
--
--   3. Removing a row left its file in storage for ever, because only
--      administrators could delete from the bucket. A lead teacher may now delete
--      the stored file of a handout or curriculum row of a class they lead (the
--      app removes the file first, then the row).
--
-- Nothing is loosened for parents or assistants: parents still read handouts only
-- and write nothing; assistants still read and write nothing in the repository.
-- ---------------------------------------------------------------------------

-- --- 1. curriculum is never readable by a family, row or file ---------------------
drop policy if exists family_documents_handout_read on storage.objects;
create policy family_documents_handout_read on storage.objects for select to authenticated using (
  bucket_id = 'family-village-private' and name like 'handouts/%' and (
    private.has_role('admin')
    or exists (
      select 1 from public.documents d
      where d.storage_path = objects.name and d.class_id is not null
        and (
          private.teaches_class(d.class_id)
          or (d.kind <> 'curriculum' and private.has_class_family_access(d.class_id))
        )
    )
  )
);

-- --- 2. removing a file follows the role --------------------------------------------
drop policy if exists documents_author_delete on public.documents;
create policy documents_author_delete on public.documents for delete to authenticated using (
  private.has_role('admin')
  or (class_id is not null and private.leads_class(class_id))
  or (class_id is null and uploaded_by_user_id = (select auth.uid()))
);

-- --- 3. a lead teacher can delete the stored file too --------------------------------
create policy family_documents_handout_lead_delete on storage.objects for delete to authenticated using (
  bucket_id = 'family-village-private' and name like 'handouts/%'
  and exists (
    select 1 from public.documents d
    where d.storage_path = objects.name and d.class_id is not null and private.leads_class(d.class_id)
  )
);
