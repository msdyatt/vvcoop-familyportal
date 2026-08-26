-- Curriculum is a teaching-team working file, while handouts are meant to be
-- shared with enrolled families. Keep both in the class repository without
-- exposing teacher-only material to parent accounts.
drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents
  for select to authenticated
  using (
    private.has_role('admin')
    or (family_id is not null and private.has_family_access(family_id))
    or (
      class_id is not null
      and (
        private.teaches_class(class_id)
        or (kind <> 'curriculum' and private.has_class_family_access(class_id))
      )
    )
  );
