-- Harmless, fully reversible probe: verifies the new CI `supabase db push`
-- job (supabase-migrations in .github/workflows/ci.yml) actually applies a
-- real migration end to end, not just a no-op when nothing is pending (which
-- is all the first run after the filename reconciliation could prove). No
-- functional effect either way.
comment on table public.print_jobs is 'CI migration pipeline verified 27 Aug 2026.';
