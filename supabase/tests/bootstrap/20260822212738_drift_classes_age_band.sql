-- classes.age_band was added to production by hand; the next real migration
-- (classes_grades_and_enrollment) reads it, and a later one drops it. Replay
-- needs it to exist at this point. CI-only; see 20260801000000_drift_baseline.sql.
alter table public.classes add column if not exists age_band text;
