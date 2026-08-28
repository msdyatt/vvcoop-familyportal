-- Blocks the exact failure mode from 28 Aug 2026: an admin using the
-- "Remove access" flow (families-tab.tsx removeUser()) on THEIR OWN account.
-- That flow assumes the acting admin remains has_role('admin')=true across
-- three parallel REST calls plus a follow-up families delete -- but the very
-- first of those calls (profiles.status -> 'removed') strips has_role('admin')
-- for that same caller the instant it commits (has_role() checks the live
-- profiles row, not a JWT claim), so whichever later call evaluates its RLS
-- check after that commit silently no-ops: PostgREST returns 204 on a DELETE
-- that matched zero rows, and the client only checked for `error`, not
-- affected-row count. Result: an admin can accidentally revoke their own
-- admin role/household access mid-flow, while a household record and its
-- children survive half-deleted with no way to recover except a manual
-- database fix -- exactly what happened: an admin account got locked out,
-- and a household was left headless with its children still attached.
--
-- Self-service removal is a real, correctly-designed, separate feature
-- (profiles_self_delete, self_service_account_deletion.sql) -- a single
-- atomic UPDATE with no follow-on steps to strand. The admin-only DELETE
-- policies below now simply refuse to ever target the caller's own row,
-- forcing genuine self-removal through that safe path instead of the
-- multi-step admin flow this bug lives in.
--
-- Also found while fixing this: family_members/user_roles each carried two
-- overlapping DELETE-authorizing policies (one from
-- 20260821031741_admin_family_management.sql, one added directly via SQL at
-- some point and never captured in a migration -- more of the same
-- untracked-drift pattern VV-06 already reconciled once). Consolidated to
-- one policy per table so this fix cannot be silently bypassed by the other,
-- unrestricted policy still being in effect.
drop policy if exists user_roles_admin_write on public.user_roles;
drop policy if exists user_roles_admin_delete on public.user_roles;
create policy user_roles_admin_delete on public.user_roles for delete to authenticated
  using (private.has_role('admin') and user_id <> (select auth.uid()));

drop policy if exists family_members_admin_write on public.family_members;
drop policy if exists family_members_admin_delete on public.family_members;
create policy family_members_admin_delete on public.family_members for delete to authenticated
  using (private.has_role('admin') and user_id <> (select auth.uid()));

-- family_members_admin_write was "for all" (insert+update+delete); dropping
-- it removes admin insert/update coverage too. The pre-existing
-- family_members_admin_insert/_admin_update policies (added outside any
-- migration) already cover this, but recreated here idempotently so this
-- migration is a complete, self-contained record of the table's intended
-- admin policy set rather than depending on undocumented live state.
drop policy if exists family_members_admin_insert on public.family_members;
create policy family_members_admin_insert on public.family_members for insert to authenticated
  with check (private.has_role('admin'));

drop policy if exists family_members_admin_update on public.family_members;
create policy family_members_admin_update on public.family_members for update to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));
