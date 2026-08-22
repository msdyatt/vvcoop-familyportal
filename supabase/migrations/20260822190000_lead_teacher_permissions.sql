-- Lead teachers publish; assistants help
-- ---------------------------------------------------------------------------
-- teacher_assignments.assignment_role has held 'lead' or 'assistant' since the
-- foundation migration, but no policy has ever read it, so the two roles have
-- been identical in every respect. A rotating parent assistant has had the same
-- authority over a class as the teacher running it.
--
-- The split: assistants see the roster, read notes and handouts, and write their
-- own student notes. Leads additionally upload handouts, set homework and class
-- events, and send print requests.
--
-- Every existing teacher_assignments row is 'lead', so nobody loses access.
--
-- Also tightened here: print_requests_insert checked only is_active_user(),
-- meaning any active member -- a parent included -- could queue a print job at
-- Sam's house. That was never intended.
-- ---------------------------------------------------------------------------

-- Mirrors private.teaches_class, but only for the lead of the class.
create or replace function private.leads_class(wanted_class_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.teacher_assignments ta
    where ta.user_id = (select auth.uid())
      and ta.class_id = wanted_class_id
      and ta.assignment_role = 'lead'
  ) and private.is_active_user();
$function$;

-- --- handouts --------------------------------------------------------------
drop policy if exists documents_teacher_write on public.documents;
create policy documents_teacher_write on public.documents
  for insert to authenticated
  with check (
    uploaded_by_user_id = (select auth.uid())
    and (
      private.has_role('admin')
      or (class_id is not null and private.leads_class(class_id))
    )
  );

-- --- homework --------------------------------------------------------------
drop policy if exists assignments_teacher_write on public.assignments;
create policy assignments_teacher_write on public.assignments
  for all to authenticated
  using (private.has_role('admin') or private.leads_class(class_id))
  with check (
    created_by = (select auth.uid())
    and (private.has_role('admin') or private.leads_class(class_id))
  );

-- --- class events ----------------------------------------------------------
-- events was admin-write only, so teachers could not schedule anything. A lead
-- may now create events for their own class, and only with the 'class'
-- audience -- publishing to the whole co-op stays with administrators.
drop policy if exists events_teacher_write on public.events;
create policy events_teacher_write on public.events
  for all to authenticated
  using (
    private.has_role('admin')
    or (audience = 'class' and class_id is not null and private.leads_class(class_id))
  )
  with check (
    private.has_role('admin')
    or (audience = 'class' and class_id is not null and private.leads_class(class_id))
  );

-- --- print requests --------------------------------------------------------
drop policy if exists print_requests_insert on public.print_requests;
create policy print_requests_insert on public.print_requests
  for insert to authenticated
  with check (
    requested_by_user_id = (select auth.uid())
    and (
      private.has_role('admin')
      -- A request may be for no particular class, so a lead of any class may
      -- send one; what matters is that parents cannot.
      or (class_id is null and private.has_role('teacher'))
      or (class_id is not null and private.leads_class(class_id))
    )
  );

-- notes_teacher_insert deliberately keeps private.teaches_class: writing a
-- student note is the main thing an assistant is there to do.
