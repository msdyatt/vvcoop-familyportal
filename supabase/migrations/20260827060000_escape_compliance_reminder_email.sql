-- send_compliance_reminders() concatenates a requirement's admin-typed title
-- straight into html_body with no escaping, unlike the edge-function-sent
-- emails (invite-family-admin, send-family-reminder), which now escape their
-- own admin-typed strings. A title containing "&" or "<" would render broken
-- in the email client; kept consistent with the edge functions' own fix
-- rather than leaving this one automated path as the odd one out.
create or replace function private.escape_html(value text)
returns text
language sql immutable set search_path to ''
as $$
  select replace(replace(replace(replace(replace(coalesce(value, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;
revoke all on function private.escape_html(text) from public, anon, authenticated;

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
    '<p>' || private.escape_html(r.title) || ' for your household is still outstanding, due ' || to_char(r.due_on, 'FMMonth FMDD') || '.</p><p>Sign in to Family Village to take care of it: <a href="https://family.veritasvillage.org/family-village/home">family.veritasvillage.org</a></p>',
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

revoke all on function public.send_compliance_reminders() from public;
