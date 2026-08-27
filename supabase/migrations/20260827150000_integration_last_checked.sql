-- QA finding VV-19: the Integrations tab's status pill is a plain editable
-- dropdown, so "Connected" shown there could be an admin's manual guess from
-- weeks ago rather than anything actually verified -- and there was no way
-- to tell the difference. testOpenSign/testResend already run a real check
-- and set status from its real result; this adds a timestamp for that same
-- moment, so the UI can show "verified 3 minutes ago" (trustworthy) next to
-- a stale or hand-set status (not).
alter table public.integration_settings add column if not exists last_checked_at timestamptz;
