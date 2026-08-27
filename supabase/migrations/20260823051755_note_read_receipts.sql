-- Note read receipts: who read a note, and when, not just a bare count.
--
-- teacher_note_reads already stored read_at; nothing selected it. Two RLS
-- gaps blocked using it once the UI tried to:
--
--   1. note_reads_select only let the note's *author* see who read it, so a
--      co-teacher/assistant on the same class saw nothing for the lead
--      teacher's notes -- "reported back to the teachers" means the class's
--      teachers, not only whoever happened to write the note.
--   2. profiles has no policy letting a teacher see a parent's display_name
--      at all, so even the author's own query would have silently returned
--      null names for every reader.
--
-- Both widened to `private.teaches_class`, and the profiles grant is scoped
-- narrowly: a teacher can see a profile only when that person has actually
-- read one of their class's notes, not parent profiles in general.
drop policy if exists note_reads_select on public.teacher_note_reads;
create policy note_reads_select on public.teacher_note_reads
  for select to authenticated
  using (
    private.has_role('admin')
    or user_id = (select auth.uid())
    or exists (
      select 1 from public.teacher_notes n
      where n.id = teacher_note_reads.note_id and private.teaches_class(n.class_id)
    )
  );

create policy profiles_teacher_note_reader on public.profiles
  for select to authenticated
  using (exists (
    select 1 from public.teacher_note_reads tnr
    join public.teacher_notes n on n.id = tnr.note_id
    where tnr.user_id = profiles.id and private.teaches_class(n.class_id)
  ));
