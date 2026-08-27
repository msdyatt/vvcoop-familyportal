-- Auto-fill requested_by from the caller's own session instead of asking every
-- print-button call site to thread an actorUserId prop down just for this --
-- reports-tab.tsx in particular has no such prop today, and adding one only
-- for attribution on an optional column isn't worth the plumbing.
alter table public.print_jobs alter column requested_by set default auth.uid();
