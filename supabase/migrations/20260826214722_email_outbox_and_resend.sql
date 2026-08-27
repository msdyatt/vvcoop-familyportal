-- Outgoing email queue. A SECURITY DEFINER SQL function (like
-- send_compliance_reminders) can insert a row here directly, but it cannot
-- make an authenticated HTTP call to Resend itself -- an edge function does
-- that part (deliver-emails), reading the API key from Supabase Vault rather
-- than a Deno env secret, since Vault is the one place this project's own
-- tooling can write a secret without needing the site owner to run a
-- `supabase secrets set` command by hand.
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  subject text not null,
  html_body text not null,
  kind text,
  subject_type text,
  subject_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error_detail text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index email_outbox_pending_idx on public.email_outbox(created_at) where status = 'pending';

alter table public.email_outbox enable row level security;

create policy email_outbox_admin_read on public.email_outbox
  for select to authenticated using (private.has_role('admin'));

grant select on public.email_outbox to authenticated;
-- No insert/update/delete grant to authenticated: only SECURITY DEFINER
-- functions (queueing) and the deliver-emails edge function's service-role
-- client (sending, which bypasses RLS) touch this table.

-- from_address is not secret -- it is the visible "From:" header -- so it
-- lives here, admin-editable from the Integrations tab, unlike the API key.
alter table public.integration_settings add column if not exists from_address text;

insert into public.integration_settings (id, display_name, status, public_note)
values ('resend', 'Resend (email)', 'not_configured', 'Set a From address below, then send a test email. The API key is stored in Supabase Vault, not this table.')
on conflict (id) do nothing;

-- Queue an email alongside the existing bell notification for the same
-- reminder, addressed to every active adult in the family who has an email
-- on file. Re-declaring the whole function (not just appending) since
-- CREATE OR REPLACE needs the full body.
create or replace function public.send_compliance_reminders()
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select fm.user_id, 'compliance_reminder',
    r.title || ' is due ' ||
      (case threshold.days when 0 then 'today' when 1 then 'tomorrow' else 'in ' || threshold.days || ' days' end),
    r.title || ' for your household is still outstanding.',
    '/family-village/home', 'family_requirement', fr.id
  from public.family_requirements fr
  join public.requirements r on r.id = fr.requirement_id
  join public.family_members fm on fm.family_id = fr.family_id
  join public.profiles p on p.id = fm.user_id
  cross join lateral (values (7), (1), (0)) as threshold(days)
  where fr.status in ('outstanding', 'sent')
    and r.active
    and r.due_on is not null
    and r.due_on = current_date + threshold.days
    and p.status = 'active'
    and not exists (
      select 1 from public.compliance_reminder_log l
      where l.family_requirement_id = fr.id and l.threshold_days = threshold.days
    );

  insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
  select p.email,
    r.title || ' is due ' || (case threshold.days when 0 then 'today' when 1 then 'tomorrow' else 'in ' || threshold.days || ' days' end),
    '<p>' || r.title || ' for your household is still outstanding, due ' || to_char(r.due_on, 'FMMonth FMDD') || '.</p><p>Sign in to Family Village to take care of it: <a href="https://family.veritasvillage.org/family-village/home">family.veritasvillage.org</a></p>',
    'compliance_reminder', 'family_requirement', fr.id
  from public.family_requirements fr
  join public.requirements r on r.id = fr.requirement_id
  join public.family_members fm on fm.family_id = fr.family_id
  join public.profiles p on p.id = fm.user_id
  cross join lateral (values (7), (1), (0)) as threshold(days)
  where fr.status in ('outstanding', 'sent')
    and r.active
    and r.due_on is not null
    and r.due_on = current_date + threshold.days
    and p.status = 'active'
    and p.email is not null and p.email <> ''
    and not exists (
      select 1 from public.compliance_reminder_log l
      where l.family_requirement_id = fr.id and l.threshold_days = threshold.days
    );

  insert into public.compliance_reminder_log (family_requirement_id, threshold_days)
  select fr.id, threshold.days
  from public.family_requirements fr
  join public.requirements r on r.id = fr.requirement_id
  cross join lateral (values (7), (1), (0)) as threshold(days)
  where fr.status in ('outstanding', 'sent')
    and r.active and r.due_on is not null and r.due_on = current_date + threshold.days
    and not exists (
      select 1 from public.compliance_reminder_log l
      where l.family_requirement_id = fr.id and l.threshold_days = threshold.days
    );
end;
$function$;

comment on function public.send_compliance_reminders is
  'Notifies every active adult in a household with a still-outstanding requirement due in 7 days, 1 day, or today -- both an in-app notification and, when the adult has an email on file, a queued email_outbox row for deliver-emails to send via Resend. Scheduled daily at 13:00 UTC (8am Central summer / 7am winter). Idempotent per (family_requirement, threshold) via compliance_reminder_log.';

revoke all on function public.send_compliance_reminders() from public;

create extension if not exists pg_net;

-- deliver-emails is gated by a shared secret (Vault: EMAIL_DELIVERY_SECRET),
-- read fresh on every scheduled run rather than baked into this migration,
-- so the secret is never committed to a file.
select cron.unschedule('deliver-emails')
where exists (select 1 from cron.job where jobname = 'deliver-emails');

select cron.schedule(
  'deliver-emails',
  '5 13 * * *',
  $$
  select net.http_post(
    url := 'https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/deliver-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-delivery-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_DELIVERY_SECRET')
    ),
    body := jsonb_build_object('mode', 'process')
  );
  $$
);
