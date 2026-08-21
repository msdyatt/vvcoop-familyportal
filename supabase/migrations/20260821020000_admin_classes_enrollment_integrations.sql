-- ---------------------------------------------------------------------------
-- 1. Admin can create/edit classes, assign teachers, and manage enrollment
--    placement. These were never given write policies or client grants.
-- ---------------------------------------------------------------------------
create policy classes_admin_write on public.classes for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant insert, update, delete on public.classes to authenticated;

create policy teacher_assignments_admin_write on public.teacher_assignments for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant insert, update, delete on public.teacher_assignments to authenticated;

create policy enrollments_admin_write on public.enrollments for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant insert, update, delete on public.enrollments to authenticated;

-- ---------------------------------------------------------------------------
-- 2. integration_settings had RLS enabled but zero policies -- meaning it was
--    completely inaccessible to the app (fail-closed). Admins need to read
--    and update connection status for Google Workspace, OpenSign, etc.
-- ---------------------------------------------------------------------------
create policy integration_settings_admin_read on public.integration_settings for select to authenticated
  using (private.has_role('admin'));
create policy integration_settings_admin_write on public.integration_settings for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
grant select, update on public.integration_settings to authenticated;

-- A dues/payments row wasn't seeded yet.
insert into public.integration_settings (id, display_name, status, public_note)
values ('dues', 'Dues & payments', 'not_configured', 'Choose a payment processor before accepting dues online.')
on conflict (id) do nothing;
