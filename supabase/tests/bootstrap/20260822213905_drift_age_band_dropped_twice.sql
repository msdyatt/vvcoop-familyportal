-- 20260822212739 already drops classes.age_band, yet the next migration
-- (20260822213906) checks it before dropping it again -- the two were applied
-- to production as separate steps but the file for the first one now contains
-- both. Put the column back (empty) so the second one can run. CI-only.
alter table public.classes add column if not exists age_band text;
