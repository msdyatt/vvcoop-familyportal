-- A fifth event audience: 'admins' (administrators only).
-- ---------------------------------------------------------------------------
-- Compliance deadlines (tax filings, renewals, board items) go on the calendar
-- for administrators and nobody else. The value is added here on its own
-- because Postgres does not let a new enum value be used in the same
-- transaction that adds it; the next migration (compliance calendar) is the
-- first to use it, and adds the read rules, the reminder recipients and the
-- checks that keep posts and photos from ever using it.
-- ---------------------------------------------------------------------------
alter type public.audience add value if not exists 'admins';
