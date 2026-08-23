-- Enrolling in an elective used to create an enrollment_requests row that sat
-- at status 'requested' with nothing to ever move it forward -- there was no
-- admin approval screen either, so a family's request had no path to actually
-- becoming an enrollment. Explicit ask: skip the confirmation step entirely --
-- a family choosing a class enrolls the child immediately, same eligibility
-- check (open window, matching grade, no same-block clash), just no wait.
--
-- Lives in public, not private: PostgREST only exposes the public schema
-- (supabase/config.toml), so a function callable via supabase.rpc() has to be
-- here even though its actual logic leans on the private.* helpers.
create or replace function public.family_self_enroll(p_period_id uuid, p_class_id uuid, p_child_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not private.has_child_family_access(p_child_id) then
    raise exception 'You do not have access to this child.';
  end if;

  -- Re-verified here, not just trusted from what the UI showed: the same
  -- window/grade/same-block-clash check the class picker was built from,
  -- checked again at the moment of enrolling in case anything changed since
  -- the page loaded.
  if not private.enrollment_request_allowed(p_period_id, p_class_id, p_child_id) then
    raise exception 'That class can''t be enrolled right now -- it may conflict with another class at the same time, or no longer match this child''s grade.';
  end if;

  insert into public.enrollment_requests (period_id, class_id, child_id, requested_by, status)
  values (p_period_id, p_class_id, p_child_id, (select auth.uid()), 'approved')
  on conflict (period_id, class_id, child_id) do update set status = 'approved';

  insert into public.enrollments (class_id, child_id, status)
  values (p_class_id, p_child_id, 'active')
  on conflict (class_id, child_id) do update set status = 'active';
end;
$$;

-- A SECURITY DEFINER function with no ACL is EXECUTE to PUBLIC by default,
-- which PostgREST would publish at /rest/v1/rpc/family_self_enroll for
-- anyone, authenticated or not -- the Supabase API is reachable directly and
-- is not behind the site's own password gate. Locked to authenticated only;
-- the function's own checks (family access, then enrollment_request_allowed)
-- are what actually decide whether a given call does anything.
revoke all on function public.family_self_enroll(uuid, uuid, uuid) from public;
grant execute on function public.family_self_enroll(uuid, uuid, uuid) to authenticated;
