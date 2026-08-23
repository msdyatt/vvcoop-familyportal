-- Integrations page cleanup: drop the rows nothing is wired to, and make the
-- Facebook row a real, functioning setting rather than a decorative one.
--
-- google-workspace, calendar, dues, and portal-email were never read by any
-- code -- confirmed by searching the app for their ids -- and portal-email's
-- status had been hand-set to "connected" despite nothing behind it. A page
-- that claims six connections when one is real is worse than a page that
-- admits to one.
--
-- The Facebook group URL was hardcoded in two files (app/page.tsx and
-- app/family-village/preview/page.tsx) and had to be edited in source to
-- change. It now lives here instead -- the one place already built for
-- editing this kind of setting from the Integrations page.
delete from public.integration_settings where id in ('google-workspace', 'calendar', 'dues', 'portal-email');

update public.integration_settings
  set display_name = 'Facebook group', status = 'connected',
      external_url = 'https://www.facebook.com/groups/960994296456160'
  where id = 'facebook';

-- The public marketing site is unauthenticated, so it needs its own narrow
-- read -- scoped to only this one row, not the rest of the table (which
-- includes OpenSign's base URL and other operational settings admins should
-- see, but the open web should not).
create policy integration_settings_public_facebook_read on public.integration_settings
  for select to anon, authenticated
  using (id = 'facebook');

-- RLS policies are checked after table privileges -- the RLS policy above is
-- inert without this.
grant select on public.integration_settings to anon;
