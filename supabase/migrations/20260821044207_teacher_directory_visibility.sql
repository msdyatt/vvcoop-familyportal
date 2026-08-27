-- Any active member can see the display name of an active teacher (a small
-- co-op directory), needed so families can see who teaches their child's
-- classes. Previously profiles were only readable by the owner or an admin.
create policy profiles_teacher_directory on public.profiles for select to authenticated using (
  private.is_active_user()
  and status = 'active'
  and exists (select 1 from public.user_roles ur where ur.user_id = profiles.id and ur.role = 'teacher')
);
