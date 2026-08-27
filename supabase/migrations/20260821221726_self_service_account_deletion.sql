-- A user can set their own profile status to 'removed' (self-delete), but
-- nothing else via this path -- they cannot reactivate themselves or change
-- any other account's status. The column-level grant already exists from an
-- earlier migration (admin write access).
create policy profiles_self_delete on public.profiles for update to authenticated using (
  id = (select auth.uid())
) with check (
  id = (select auth.uid()) and status = 'removed'
);
