create table public.compliance_reminder_log (
  id uuid primary key default gen_random_uuid(),
  family_requirement_id uuid not null references public.family_requirements(id) on delete cascade,
  threshold_days integer not null,
  sent_at timestamptz not null default now(),
  unique (family_requirement_id, threshold_days)
);

alter table public.compliance_reminder_log enable row level security;

create policy compliance_reminder_log_admin_read on public.compliance_reminder_log
  for select to authenticated using (private.has_role('admin'));

grant select on public.compliance_reminder_log to authenticated;
-- No insert/update/delete grant to authenticated: only the SECURITY DEFINER
-- cron function below writes here.

create or replace function public.send_compliance_reminders()
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  -- Bell notification for every active adult in a household whose
  -- requirement is still outstanding and lands on a 7-day, 1-day, or
  -- due-today threshold, skipping any (family_requirement, threshold) pair
  -- already logged so a daily run never repeats itself.
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
  'Notifies every active adult in a household with a still-outstanding requirement due in 7 days, 1 day, or today. Scheduled daily at 13:00 UTC (8am Central summer / 7am winter). Idempotent per (family_requirement, threshold) via compliance_reminder_log. In-app notification only today -- email delivery (via email_outbox + Resend) is a planned follow-up once the sending domain is configured.';

revoke all on function public.send_compliance_reminders() from public;

create extension if not exists pg_cron;

select cron.unschedule('send-compliance-reminders')
where exists (select 1 from cron.job where jobname = 'send-compliance-reminders');

select cron.schedule('send-compliance-reminders', '0 13 * * *', $$select public.send_compliance_reminders()$$);
