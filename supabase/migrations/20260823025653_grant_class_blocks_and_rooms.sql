-- Table privileges are checked before RLS, so a table with policies but no
-- GRANT is a table nobody can read: every request fails 42501 long before a
-- policy is consulted. `classes` carries these grants; the two new reference
-- tables in 20260824090000 were created without them and would have failed for
-- every signed-in user. anon is deliberately left out -- the timetable is
-- behind the login.
grant select, insert, update, delete on public.class_blocks to authenticated;
grant select, insert, update, delete on public.rooms        to authenticated;
