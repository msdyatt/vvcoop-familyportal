-- Teachers can delete their own notes (admin can delete any).
create policy notes_author_delete on public.teacher_notes for delete to authenticated using (
  author_user_id = (select auth.uid()) or private.has_role('admin')
);
grant delete on public.teacher_notes to authenticated;

-- Read-receipt tracking: any number of family members can each confirm
-- they've read a note; a teacher/admin can see who has.
create table if not exists public.teacher_note_reads (
  note_id uuid not null references public.teacher_notes(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  read_at timestamptz not null default now(),
  primary key (note_id, user_id)
);
alter table public.teacher_note_reads enable row level security;

create policy note_reads_insert_own on public.teacher_note_reads for insert to authenticated with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.teacher_notes n where n.id = note_id)
);
create policy note_reads_select on public.teacher_note_reads for select to authenticated using (
  private.has_role('admin')
  or user_id = (select auth.uid())
  or exists (select 1 from public.teacher_notes n where n.id = note_id and n.author_user_id = (select auth.uid()))
);
grant select, insert on public.teacher_note_reads to authenticated;

-- A family member can add their own child to their own household (previously
-- only an admin could add any child at all).
create policy children_family_insert on public.children for insert to authenticated with check (
  private.is_active_user()
  and exists (select 1 from public.family_members fm where fm.family_id = children.family_id and fm.user_id = (select auth.uid()))
);
