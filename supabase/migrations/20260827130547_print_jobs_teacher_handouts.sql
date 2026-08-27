-- Scope correction: the duplex/office-printer queue was originally wired
-- into every admin print button (Reports, master roster, class roster).
-- That was a misread -- it only belongs in the teacher print-request area
-- (PrintSection in teacher/workspace.tsx, backed by the pre-existing
-- print_requests/handouts feature), as an additional option alongside the
-- existing manual print queue, not a replacement for it.
--
-- A teacher's upload is an arbitrary file (PDF, doc, image -- whatever
-- print_requests already accepts), not a DOM element this app can render an
-- HTML snapshot of. print_jobs needs a second way to carry a job's content:
-- a storage_path the eventual Pi script downloads and prints directly via
-- IPP/CUPS (which handles those formats natively), alongside the existing
-- html_body path the admin reports use. Exactly one of the two is required.
alter table public.print_jobs add column if not exists storage_path text;
alter table public.print_jobs alter column html_body drop not null;
alter table public.print_jobs add constraint print_jobs_has_content
  check (html_body is not null or storage_path is not null);

-- Teachers can queue and see their own jobs; the existing print_jobs_admin_all
-- policy already covers admins seeing/managing everything, unchanged.
create policy print_jobs_teacher_insert on public.print_jobs
  for insert to authenticated
  with check (requested_by = (select auth.uid()) and private.has_role('teacher'));

create policy print_jobs_teacher_read on public.print_jobs
  for select to authenticated
  using (requested_by = (select auth.uid()));
