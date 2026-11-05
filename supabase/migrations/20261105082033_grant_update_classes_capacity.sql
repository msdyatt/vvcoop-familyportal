-- PR #9 added classes.capacity, but UPDATE on public.classes is granted
-- per-column to authenticated (the RLS policy lets an admin touch the row; the
-- column grant gates which columns). capacity was never added to that list, so
-- Admin -> Classes -> Save -- which always sends capacity alongside the other
-- columns -- would fail every class edit with "permission denied for table
-- classes". Same shape as 20260827010351_allow_move_child_family.sql, which
-- fixed it for children.family_id. GRANT UPDATE (col) is additive.
grant update (capacity) on public.classes to authenticated;
