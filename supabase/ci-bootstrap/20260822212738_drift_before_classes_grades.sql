-- classes.age_band was added to production by hand; the next real migration
-- (classes_grades_and_enrollment) reads it, and a later one drops it. Replay
-- needs it to exist at this point. CI-only; see 20260801000000_drift_baseline.sql.
alter table public.classes add column if not exists age_band text;
alter table public.classes add column if not exists block_label text;

-- The enrollment_requests policy added by that migration calls this, and the
-- function itself was also created by hand. A permissive stand-in is enough to
-- let the policy be created; migration 20260826103305 later redefines it for real.
create schema if not exists private;
create or replace function private.enrollment_request_allowed(wanted_period_id uuid, wanted_class_id uuid, wanted_child_id uuid)
returns boolean language sql stable as $$ select true $$;
