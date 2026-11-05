-- Production holds table privileges for signed-in users that no migration ever
-- granted: they were applied by hand (or came from an earlier default) and
-- recorded nowhere. Row-level security still decides which rows anyone can
-- touch; these are the table-level privileges it sits on top of.
--
-- Found by replaying the whole migration history into an empty database and
-- comparing its grants with production's. Without these lines a database
-- rebuilt from the migrations alone would load but fail on, among others,
-- creating events, creating households, inviting people (profiles, user roles),
-- and a family editing their child's birthdate or photo.
--
-- Every statement here is already true in production, so applying this
-- migration there changes nothing; it makes the history match reality.
grant update on public.children to authenticated;
grant update on public.documents to authenticated;
grant insert, update, delete on public.events to authenticated;
grant insert, update, delete on public.families to authenticated;
grant update on public.family_members to authenticated;
grant insert on public.integration_settings to authenticated;
grant insert, delete on public.profiles to authenticated;
grant insert, update on public.user_roles to authenticated;
