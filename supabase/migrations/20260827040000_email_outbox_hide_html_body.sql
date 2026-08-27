-- email_outbox_admin_read (email_outbox_and_resend.sql) lets any admin read
-- every row in this table, but html_body is not just a copy of what was
-- sent -- for an invite email it's the actual live, one-time sign-in link
-- (invite-family-admin switched from Supabase's own inviteUserByEmail, which
-- never exposes the link, to generateLink() + emailing the link itself). Any
-- admin -- or anyone who compromises one admin session -- could read
-- `select html_body from email_outbox` from the browser console and sign in
-- as a family they never invited, with no expiry shorter than the link's own
-- and no retention limit on the row.
--
-- Nothing in the app currently reads html_body from the client (confirmed:
-- no admin UI queries this table at all yet), so narrowing the grant to
-- every column except it costs nothing today and closes the leak outright,
-- rather than trying to redact or scope it per-sender.
revoke select on public.email_outbox from authenticated;
grant select (id, recipient_email, subject, kind, subject_type, subject_id, status, error_detail, created_at, sent_at)
  on public.email_outbox to authenticated;
