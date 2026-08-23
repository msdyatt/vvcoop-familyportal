-- Profile pictures for parents (self-managed) and children (admin-managed,
-- matching every other field on a child's record -- families cannot update
-- their own child's row today, only add one, so this stays consistent rather
-- than carving out a one-field exception).
--
-- No new RLS: avatar_path is a plain column on rows already governed by
-- profiles_self_update / children_admin_update, and the file itself lives at
-- a random, unguessable path in the existing private bucket -- the same
-- security model every other private file in this project already relies on.
alter table public.profiles add column if not exists avatar_path text;
alter table public.children add column if not exists avatar_path text;
