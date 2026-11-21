-- Compliance calendar: nonprofit filing deadlines and renewals, for administrators only.
-- ---------------------------------------------------------------------------
-- What this adds
--   * Admin-only events (audience 'admins'). events_read shows them to administrators at the
--     right two-factor level and to nobody else; reviewer (demo) accounts never see them
--     (demo_isolation). Posts and photos can never use the audience. Event reminders for an
--     admin-only event go to administrators only.
--   * compliance_settings: the facts the deadlines depend on (fiscal year end, state,
--     employees, contractors, usual size of gross receipts) and the on/off switches for the
--     optional rules.
--   * private.compliance_rule_catalog(): the rules list. Each rule has a plain description, who
--     it applies to, how its date is worked out, whether it moves off weekends and holidays,
--     and the official page it comes from. Anything not certain to apply to a small Texas
--     501(c)(3) is optional and marked "check".
--   * compliance_deadlines: one row per deadline occurrence, generated from the rules for the
--     next 18 months (plus custom ones an administrator adds), with status, filing date,
--     confirmation number and an optional records-vault document. Each has a matching
--     admin-only all-day event on the calendar.
--   * A nightly job (pg_cron): regenerate the deadlines (idempotent: the unique key on
--     (rule, occurrence) means a second run changes nothing), then remind administrators 60,
--     30 and 7 days before each open deadline through public.notifications, the same place
--     every sender reads (bell, push, email fallback, quiet mode, delivery log).
--
-- Dates: the IRS moves a due date that falls on a Saturday, Sunday or legal holiday to the
-- next business day (IRC 7503). Legal holidays here are the federal holidays (5 U.S.C. 6103,
-- with the Friday/Monday observed day) plus DC Emancipation Day (16 April), which the IRS also
-- observes. Inauguration Day is not included. The same roll-forward is used for the Texas
-- dates, which should be confirmed with the Comptroller.
--
-- Nothing here decides what the law requires. The descriptions say "check" where the co-op
-- should confirm with the IRS, the Texas Comptroller, the Texas Secretary of State or a tax
-- professional.
-- ---------------------------------------------------------------------------

-- --- admin-only events ----------------------------------------------------------------------
alter table public.events
  add column if not exists managed_by text check (managed_by is null or managed_by = 'compliance');
comment on column public.events.managed_by is
  'Set when the event is kept in step with another feature (''compliance'': a compliance deadline). Such an event is changed only by that feature, never directly by a browser.';

alter table public.events
  add constraint events_admins_no_class check (audience <> 'admins' or class_id is null);
alter table public.posts
  add constraint posts_not_admins check (audience <> 'admins');
alter table public.media
  add constraint media_not_admins check (audience <> 'admins');

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (
  audience in ('public', 'families')
  or (audience = 'teachers' and (private.has_role('teacher') or private.has_role('admin')))
  or (audience = 'class' and (private.teaches_class(class_id) or private.has_class_family_access(class_id) or private.has_role('admin')))
  or (audience = 'admins' and private.has_role('admin') and private.aal_satisfied())
);

-- A compliance event follows its deadline. A browser (even an administrator's) cannot change,
-- move, re-audience or delete it, nor create one that claims to be managed.
create or replace function private.guard_managed_events()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if current_user not in ('authenticated', 'anon') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.managed_by is not null then raise exception 'That event is managed by the portal.' using errcode = '42501'; end if;
    return new;
  end if;
  if old.managed_by is not null then
    raise exception 'This deadline is managed on Admin, Compliance.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.managed_by is not null then
    raise exception 'That event is managed by the portal.' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists events_guard_managed on public.events;
create trigger events_guard_managed
  before insert or update or delete on public.events
  for each row execute function private.guard_managed_events();

-- Event reminders: an admin-only event is reminded to administrators only.
create or replace function private.event_recipients(p_event_id uuid)
returns table (user_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select p.id
  from public.events e
  join public.profiles p
    on p.status = 'active' and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org'
  where e.id = p_event_id and not e.is_demo
    and coalesce((select np.event_reminders from public.notification_preferences np where np.user_id = p.id), true)
    and (
      e.audience in ('public', 'families')
      or (e.audience = 'teachers' and exists (
            select 1 from public.user_roles r where r.user_id = p.id and r.role in ('teacher', 'admin')))
      or (e.audience = 'admins' and exists (
            select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin'))
      or (e.audience = 'class' and e.class_id is not null and (
            exists (select 1 from public.teacher_assignments ta where ta.class_id = e.class_id and ta.user_id = p.id)
            or exists (
              select 1 from public.enrollments en
              join public.children c on c.id = en.child_id
              join public.family_members fm on fm.family_id = c.family_id
              where en.class_id = e.class_id and en.status = 'active' and fm.user_id = p.id)))
    );
$function$;
revoke all on function private.event_recipients(uuid) from public, anon, authenticated;
revoke all on function private.guard_managed_events() from public, anon, authenticated;

-- --- settings -----------------------------------------------------------------------------
create table public.compliance_settings (
  id text primary key default 'org' check (id = 'org'),
  -- The month the fiscal (tax) year ends; the year ends on that month's last day.
  fiscal_year_end_month integer not null default 12 check (fiscal_year_end_month between 1 and 12),
  -- Only Texas rules are written so far.
  state text not null default 'TX' check (state = 'TX'),
  has_employees boolean not null default false,
  pays_contractors boolean not null default false,
  -- The usual size of gross receipts, which picks the IRS return named on the calendar.
  -- The year-end tax summary works it out properly from the books.
  gross_receipts_size text not null default 'up_to_50k'
    check (gross_receipts_size in ('up_to_50k', 'under_200k', '200k_or_more')),
  -- On/off for the optional rules, by rule key. A missing key means the rule's default.
  rule_switches jsonb not null default '{}'::jsonb check (jsonb_typeof(rule_switches) = 'object'),
  board_meeting_month integer not null default 1 check (board_meeting_month between 1 and 12),
  board_meeting_day integer not null default 31 check (board_meeting_day between 1 and 31),
  handbook_month integer not null default 7 check (handbook_month between 1 and 12),
  handbook_day integer not null default 15 check (handbook_day between 1 and 31),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.compliance_settings (id) values ('org') on conflict do nothing;

alter table public.compliance_settings enable row level security;
create policy compliance_settings_admin_read on public.compliance_settings
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.compliance_settings as restrictive
  for all to authenticated using (private.aal_satisfied());
create policy no_demo_access on public.compliance_settings as restrictive
  for select to authenticated using (not private.is_demo_user());
revoke all on public.compliance_settings from public, anon, authenticated;
grant select on public.compliance_settings to authenticated;

-- --- dates ----------------------------------------------------------------------------------
-- The n-th given weekday of a month (dow 0 = Sunday ... 6 = Saturday); n = -1 is the last one.
create or replace function private.nth_weekday(p_year integer, p_month integer, p_dow integer, p_n integer)
returns date
language sql immutable set search_path to ''
as $function$
  select case when p_n > 0
    then make_date(p_year, p_month, 1) + ((p_dow - extract(dow from make_date(p_year, p_month, 1))::int + 7) % 7) + 7 * (p_n - 1)
    else (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date
         - ((extract(dow from (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date)::int - p_dow + 7) % 7)
  end;
$function$;

-- A fixed-date holiday on a Saturday is observed the Friday before; on a Sunday, the Monday after.
create or replace function private.observed_day(p_date date)
returns date
language sql immutable set search_path to ''
as $function$
  select case extract(dow from p_date)::int when 6 then p_date - 1 when 0 then p_date + 1 else p_date end;
$function$;

-- Legal holidays (observed days) that the IRS treats as non-business days, for one year.
-- An observed day can fall in the year before (New Year's Day on a Saturday is observed on
-- 31 December), so the next year's New Year's Day is included when it lands in this year.
create or replace function private.us_legal_holidays(p_year integer)
returns setof date
language sql immutable set search_path to ''
as $function$
  select d from (
    select private.observed_day(make_date(p_year, 1, 1)) as d            -- New Year's Day
    union all select private.observed_day(make_date(p_year + 1, 1, 1))   -- next New Year's Day (may be 31 Dec)
    union all select private.nth_weekday(p_year, 1, 1, 3)                 -- Birthday of Martin Luther King, Jr.
    union all select private.nth_weekday(p_year, 2, 1, 3)                 -- Washington's Birthday
    union all select private.observed_day(make_date(p_year, 4, 16))       -- DC Emancipation Day (IRS observes it)
    union all select private.nth_weekday(p_year, 5, 1, -1)                -- Memorial Day
    union all select private.observed_day(make_date(p_year, 6, 19)) where p_year >= 2021  -- Juneteenth
    union all select private.observed_day(make_date(p_year, 7, 4))        -- Independence Day
    union all select private.nth_weekday(p_year, 9, 1, 1)                 -- Labor Day
    union all select private.nth_weekday(p_year, 10, 1, 2)                -- Columbus Day
    union all select private.observed_day(make_date(p_year, 11, 11))      -- Veterans Day
    union all select private.nth_weekday(p_year, 11, 4, 4)                -- Thanksgiving Day
    union all select private.observed_day(make_date(p_year, 12, 25))      -- Christmas Day
  ) h
  where extract(year from d)::int = p_year;
$function$;

create or replace function private.is_business_day(p_date date)
returns boolean
language sql immutable set search_path to ''
as $function$
  select extract(dow from p_date)::int not in (0, 6)
     and not exists (select 1 from private.us_legal_holidays(extract(year from p_date)::int) h where h = p_date);
$function$;

-- A due date on a weekend or legal holiday moves to the next business day.
create or replace function private.roll_forward(p_date date)
returns date
language plpgsql immutable set search_path to ''
as $function$
declare d date := p_date;
begin
  if d is null then return null; end if;
  while not private.is_business_day(d) loop d := d + 1; end loop;
  return d;
end;
$function$;

-- The last day of a fiscal year that ends in p_month of p_year.
create or replace function private.fiscal_year_end(p_month integer, p_year integer)
returns date
language sql immutable set search_path to ''
as $function$
  select (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
$function$;

-- The 15th day of the 5th month after the fiscal year ends (before any roll-forward):
-- 15 May for a year ending 31 December, 15 November for one ending 30 June.
create or replace function private.annual_return_due(p_month integer, p_year integer)
returns date
language sql immutable set search_path to ''
as $function$
  select (make_date(p_year, p_month, 1) + interval '5 months')::date + 14;
$function$;

-- A month and day in a year, with the day pulled back to the month's last day (31 -> 30 June).
create or replace function private.clamped_date(p_year integer, p_month integer, p_day integer)
returns date
language sql immutable set search_path to ''
as $function$
  select make_date(p_year, p_month, least(p_day, extract(day from (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day'))::int));
$function$;

-- --- the rules ------------------------------------------------------------------------------
-- The list the generator follows and the Compliance page shows. Keys never change once
-- shipped (they identify generated deadlines).
create or replace function private.compliance_rule_catalog()
returns table (
  key text, title text, description text, applies_to text, date_rule text, roll_forward boolean,
  source_label text, source_url text, optional boolean, default_on boolean, needs_check boolean,
  needs text, sort_order integer)
language sql immutable set search_path to ''
as $function$
  select * from (values
    ('irs_annual_return',
     'IRS annual return (Form 990-N, 990-EZ or 990)',
     'Every year a 501(c)(3) files one of these with the IRS. The small-organisation version, the 990-N (e-Postcard), is for gross receipts normally $50,000 or less; the year-end tax summary shows which one probably applies. Form 8868 gives an automatic 6-month extension for the 990-EZ and 990, but not for the 990-N. Not filing for three years in a row means the IRS automatically revokes tax-exempt status.',
     'Every 501(c)(3)',
     '15th day of the 5th month after the fiscal year ends (15 May for a 31 December year end)',
     true, 'IRS: annual exempt organization return due date',
     'https://www.irs.gov/charities-non-profits/annual-exempt-organization-return-due-date',
     false, true, false, 'always', 10),
    ('irs_990t',
     'IRS Form 990-T (unrelated business income), check',
     'Only needed if the co-op had $1,000 or more of gross income in the year from a trade or business that is regularly carried on and not related to its exempt purpose. Typical co-op dues and occasional fundraisers are usually not this, but confirm with a tax professional before switching it off for good.',
     'Only with $1,000 or more of unrelated business gross income',
     'Same day as the annual return: 15th day of the 5th month after the fiscal year ends',
     true, 'IRS: About Form 990-T',
     'https://www.irs.gov/forms-pubs/about-form-990-t',
     true, false, true, 'optional', 20),
    ('irs_1099_nec',
     'Forms 1099-NEC to contractors and the IRS (and Form 1096 if filing on paper)',
     'For each independent contractor (a person or unincorporated business, not an employee) paid for services in the calendar year: give them a Form 1099-NEC and file it with the IRS. The threshold is $600 for payments made through 2025 and $2,000 for payments made in 2026, adjusted for inflation after that. Paper filers send Form 1096 with the paper forms. Payments made by card or a payment app are reported by the payment company instead. Collect a Form W-9 from each contractor before paying them.',
     'Co-ops that pay independent contractors',
     '31 January after the calendar year of the payments',
     true, 'IRS: Instructions for Forms 1099-MISC and 1099-NEC',
     'https://www.irs.gov/instructions/i1099mec',
     false, true, false, 'contractors', 30),
    ('irs_941',
     'IRS Form 941 (quarterly payroll tax return)',
     'Reports income tax withheld and Social Security and Medicare taxes for employees, every quarter. Very small employers may be told by the IRS to file Form 944 once a year instead. A 501(c)(3) does not normally pay federal unemployment tax, so Form 940 is usually not needed; confirm with your payroll provider.',
     'Only co-ops with employees',
     'Last day of the month after each quarter: 30 April, 31 July, 31 October, 31 January',
     true, 'IRS: About Form 941',
     'https://www.irs.gov/forms-pubs/about-form-941',
     false, true, false, 'employees', 40),
    ('irs_w2',
     'Forms W-2 to employees and W-2/W-3 to the Social Security Administration',
     'Each employee gets a Form W-2 for the calendar year, and copies go to the Social Security Administration with Form W-3.',
     'Only co-ops with employees',
     '31 January after the calendar year',
     true, 'IRS: About Form W-2',
     'https://www.irs.gov/forms-pubs/about-form-w-2',
     false, true, false, 'employees', 50),
    ('tx_twc_wage_report',
     'Texas Workforce Commission quarterly wage report, check',
     'Texas employers report wages to the Texas Workforce Commission every quarter. A nonprofit may be able to reimburse TWC for benefits paid instead of paying unemployment tax, but the reports are still due. Confirm with the Texas Workforce Commission.',
     'Only co-ops with employees',
     'Last day of the month after each quarter',
     true, 'Texas Workforce Commission: unemployment tax',
     'https://www.twc.texas.gov/businesses/unemployment-tax',
     true, true, true, 'employees', 60),
    ('tx_franchise_exemption',
     'Texas franchise tax: confirm the exemption with the Texas Comptroller, check',
     'A 501(c)(3) can apply to the Texas Comptroller (Form AP-204) for exemption from franchise and sales tax. Until the exemption is granted, a franchise tax report is due each year on 15 May. Confirm the co-op''s status with the Texas Comptroller; once the exemption letter is in the records vault, mark each year "not needed" or switch this off.',
     'Texas nonprofits without a confirmed franchise tax exemption',
     '15 May each year',
     true, 'Texas Comptroller: 501(c)(3) exemptions',
     'https://comptroller.texas.gov/taxes/exempt/501(c)-exemptions-1.php',
     true, true, true, 'optional', 70),
    ('tx_sos_periodic_report',
     'Texas Secretary of State periodic report (only when asked), check',
     'The Texas Secretary of State can ask a nonprofit corporation for a periodic report, no more than once every four years. It is due 30 days after the notice. There is no fixed date, so nothing goes on the calendar automatically: add a custom deadline when a notice arrives. Confirm with the Texas Secretary of State.',
     'Texas nonprofit corporations that receive a notice',
     'Only when a notice arrives: 30 days after it',
     false, 'Texas Secretary of State: nonprofit organizations',
     'https://www.sos.state.tx.us/corp/nonprofit_org.shtml',
     false, true, true, 'notice', 80),
    ('vault_renewal',
     'Renewals from the records vault',
     'Every record in the records vault (insurance policies, the church lease, licences, contracts) that has an expiry date gets a renewal deadline on that date.',
     'Every record with an expiry date',
     'The record''s expiry date (not moved for weekends)',
     false, 'Your records vault', null,
     false, true, false, 'always', 90),
    ('annual_board_meeting',
     'Annual board meeting',
     'Hold the annual board meeting your bylaws call for, and keep the minutes in the records vault. Check your bylaws for when it must be held.',
     'Co-ops whose bylaws call for one',
     'The date set in Compliance settings (31 January unless changed)',
     false, 'Texas Business Organizations Code, chapter 22 (nonprofit corporations)',
     'https://statutes.capitol.texas.gov/Docs/BO/htm/BO.22.htm',
     true, true, true, 'optional', 100),
    ('conflict_of_interest',
     'Conflict-of-interest statements from board members',
     'Ask each board member to sign the annual conflict-of-interest statement. Not required by law for a small co-op, but the IRS recommends a written policy, and the long Form 990 asks about one.',
     'Optional good practice',
     'Same date as the annual board meeting',
     false, 'IRS: Governance and related topics for 501(c)(3) organizations',
     'https://www.irs.gov/pub/irs-tege/governance_practices.pdf',
     true, true, false, 'optional', 110),
    ('handbook_waiver_refresh',
     'Refresh the family handbook and waivers before the school year',
     'Review the handbook, the liability waiver and the other forms families sign, and update them in Admin, Documents before enrollment opens.',
     'Co-op policy (no outside rule)',
     'The date set in Compliance settings (15 July unless changed)',
     false, 'Co-op policy', null,
     true, true, false, 'optional', 120)
  ) as r(key, title, description, applies_to, date_rule, roll_forward, source_label, source_url, optional, default_on, needs_check, needs, sort_order);
$function$;

-- Is a rule on, given the settings?
create or replace function private.compliance_rule_on(p_key text, s public.compliance_settings)
returns boolean
language sql stable set search_path to ''
as $function$
  select coalesce((
    select case r.needs
      when 'contractors' then s.pays_contractors and (not r.optional or coalesce((s.rule_switches ->> r.key)::boolean, r.default_on))
      when 'employees' then s.has_employees and (not r.optional or coalesce((s.rule_switches ->> r.key)::boolean, r.default_on))
      when 'notice' then false
      when 'optional' then coalesce((s.rule_switches ->> r.key)::boolean, r.default_on)
      else true end
    from private.compliance_rule_catalog() r where r.key = p_key), false);
$function$;

-- --- deadlines --------------------------------------------------------------------------------
create table public.compliance_deadlines (
  id uuid primary key default gen_random_uuid(),
  -- Generated deadlines: the rule and which occurrence (e.g. 'FY2026-12-31', '2027-Q1', a vault
  -- record id and expiry date). Both null for a deadline an administrator added by hand.
  rule_key text,
  occurrence_key text,
  title text not null check (char_length(title) between 1 and 200),
  details text check (details is null or char_length(details) <= 2000),
  period_label text check (period_label is null or char_length(period_label) <= 80),
  -- The date the rule gives, and the date after moving off a weekend or holiday.
  nominal_due_on date not null,
  due_on date not null,
  source_url text check (source_url is null or source_url ~ '^https://'),
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'filed', 'not_needed')),
  filed_on date,
  confirmation_number text check (confirmation_number is null or char_length(confirmation_number) <= 120),
  record_id uuid references public.org_records(id) on delete set null,
  status_note text check (status_note is null or char_length(status_note) <= 1000),
  -- The vault record a renewal came from.
  vault_record_id uuid references public.org_records(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  -- A generated deadline the rules no longer produce (settings changed) but that already had
  -- progress recorded, so it is kept for the history instead of being deleted.
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint compliance_deadlines_occurrence unique (rule_key, occurrence_key),
  constraint compliance_deadlines_generated_shape check ((rule_key is null) = (occurrence_key is null)),
  constraint compliance_deadlines_filed_shape check ((status = 'filed') = (filed_on is not null))
);
create index compliance_deadlines_due_idx on public.compliance_deadlines (due_on);

alter table public.compliance_deadlines enable row level security;
create policy compliance_deadlines_admin_read on public.compliance_deadlines
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.compliance_deadlines as restrictive
  for all to authenticated using (private.aal_satisfied());
create policy no_demo_access on public.compliance_deadlines as restrictive
  for select to authenticated using (not private.is_demo_user());
revoke all on public.compliance_deadlines from public, anon, authenticated;
grant select on public.compliance_deadlines to authenticated;

-- A deadline that goes (deleted, or with its vault record when that is erased) takes its
-- calendar event with it.
create or replace function private.compliance_deadline_drop_event()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if old.event_id is not null then delete from public.events where id = old.event_id and managed_by = 'compliance'; end if;
  return null;
end;
$function$;
revoke all on function private.compliance_deadline_drop_event() from public, anon, authenticated;
create trigger compliance_deadlines_drop_event
  after delete on public.compliance_deadlines
  for each row execute function private.compliance_deadline_drop_event();

create table public.compliance_deadline_reminder_log (
  deadline_id uuid not null references public.compliance_deadlines(id) on delete cascade,
  offset_days integer not null,
  due_on date not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (deadline_id, offset_days, due_on, user_id)
);
alter table public.compliance_deadline_reminder_log enable row level security;
create policy compliance_deadline_reminder_log_admin_read on public.compliance_deadline_reminder_log
  for select to authenticated using (private.has_role('admin'));
create policy aal2_required on public.compliance_deadline_reminder_log as restrictive
  for all to authenticated using (private.aal_satisfied());
revoke all on public.compliance_deadline_reminder_log from public, anon, authenticated;
grant select on public.compliance_deadline_reminder_log to authenticated;

-- --- what the rules produce ------------------------------------------------------------------
-- Every deadline the rules give whose due date is from p_today to 18 months after it.
create or replace function private.compliance_desired(p_today date)
returns table (rule_key text, occurrence_key text, title text, details text, period_label text,
               nominal_due_on date, due_on date, source_url text, vault_record_id uuid)
language plpgsql stable security definer set search_path to ''
as $function$
declare
  s public.compliance_settings;
  v_until date := (p_today + interval '18 months')::date;
  v_y0 integer := extract(year from p_today)::int - 1;
  v_form text;
begin
  select * into s from public.compliance_settings where id = 'org';
  v_form := case s.gross_receipts_size when 'up_to_50k' then 'IRS Form 990-N (e-Postcard)' when 'under_200k' then 'IRS Form 990-EZ' else 'IRS Form 990' end;

  return query
  with years as (select generate_series(v_y0, v_y0 + 3) as y),
  rules as (select * from private.compliance_rule_catalog()),
  raw as (
    -- annual return and 990-T, per fiscal year
    select 'irs_annual_return'::text as k, 'FY' || private.fiscal_year_end(s.fiscal_year_end_month, y)::text as occ,
      v_form || ' for the year ending ' || to_char(private.fiscal_year_end(s.fiscal_year_end_month, y), 'FMMonth FMDD, YYYY') as t,
      'Fiscal year ending ' || to_char(private.fiscal_year_end(s.fiscal_year_end_month, y), 'FMMonth FMDD, YYYY') as per,
      private.annual_return_due(s.fiscal_year_end_month, y) as nominal, null::uuid as rec
    from years
    union all
    select 'irs_990t', 'FY' || private.fiscal_year_end(s.fiscal_year_end_month, y)::text,
      'IRS Form 990-T for the year ending ' || to_char(private.fiscal_year_end(s.fiscal_year_end_month, y), 'FMMonth FMDD, YYYY') || ' (check)',
      'Fiscal year ending ' || to_char(private.fiscal_year_end(s.fiscal_year_end_month, y), 'FMMonth FMDD, YYYY'),
      private.annual_return_due(s.fiscal_year_end_month, y), null
    from years
    -- calendar-year information returns, due 31 January
    union all
    select 'irs_1099_nec', 'CY' || y, 'Forms 1099-NEC for ' || y || ' contractor payments', 'Calendar year ' || y, make_date(y + 1, 1, 31), null from years
    union all
    select 'irs_w2', 'CY' || y, 'Forms W-2 and W-3 for ' || y, 'Calendar year ' || y, make_date(y + 1, 1, 31), null from years
    -- quarterly payroll
    union all
    select k, y || '-Q' || q, t || ' for Q' || q || ' ' || y, 'Q' || q || ' ' || y,
      case q when 1 then make_date(y, 4, 30) when 2 then make_date(y, 7, 31) when 3 then make_date(y, 10, 31) else make_date(y + 1, 1, 31) end, null
    from years cross join generate_series(1, 4) q
    cross join (values ('irs_941', 'IRS Form 941'), ('tx_twc_wage_report', 'Texas Workforce Commission wage report')) w(k, t)
    -- Texas franchise tax
    union all
    select 'tx_franchise_exemption', y::text, 'Texas franchise tax report or confirmed exemption for ' || y || ' (check)', 'Report year ' || y, make_date(y, 5, 15), null from years
    -- governance
    union all
    select 'annual_board_meeting', y::text, 'Annual board meeting ' || y, 'Year ' || y, private.clamped_date(y, s.board_meeting_month, s.board_meeting_day), null from years
    union all
    select 'conflict_of_interest', y::text, 'Conflict-of-interest statements for ' || y, 'Year ' || y, private.clamped_date(y, s.board_meeting_month, s.board_meeting_day), null from years
    union all
    select 'handbook_waiver_refresh', y::text, 'Refresh the handbook and waivers for the ' || y || '-' || right((y + 1)::text, 2) || ' school year', 'School year ' || y || '-' || right((y + 1)::text, 2),
      private.clamped_date(y, s.handbook_month, s.handbook_day), null from years
    -- vault renewals
    union all
    select 'vault_renewal', o.id::text || ':' || o.expires_on::text,
      'Renew: ' || o.title || coalesce(' (' || o.issuer || ')', ''), 'Expires ' || to_char(o.expires_on, 'FMMonth FMDD, YYYY'), o.expires_on, o.id
    from public.org_records o where o.archived_at is null and o.expires_on is not null
  )
  select raw.k, raw.occ, raw.t,
    r.description || case when r.key = 'irs_1099_nec' then
      ' Threshold for these payments: ' || case when split_part(raw.occ, 'CY', 2)::int <= 2025 then '$600.' when split_part(raw.occ, 'CY', 2)::int = 2026 then '$2,000.' else '$2,000 adjusted for inflation; check the current IRS instructions.' end
      else '' end,
    raw.per, raw.nominal,
    case when r.roll_forward then private.roll_forward(raw.nominal) else raw.nominal end,
    r.source_url, raw.rec
  from raw join rules r on r.key = raw.k
  where private.compliance_rule_on(raw.k, s)
    and (case when r.roll_forward then private.roll_forward(raw.nominal) else raw.nominal end) between p_today and v_until;
end;
$function$;

-- --- the calendar event that mirrors a deadline ------------------------------------------------
create or replace function private.compliance_sync_event(p_deadline uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  d public.compliance_deadlines;
  v_title text;
  v_desc text;
  v_start timestamptz;
  v_event uuid;
begin
  select * into d from public.compliance_deadlines where id = p_deadline;
  if not found then return; end if;
  if d.retired_at is not null then
    if d.event_id is not null then
      update public.compliance_deadlines set event_id = null where id = d.id;
      delete from public.events where id = d.event_id;
    end if;
    return;
  end if;
  v_title := left(case d.status when 'filed' then 'Filed: ' when 'not_needed' then 'Not needed: ' else 'Due: ' end || d.title, 200);
  v_desc := concat_ws(E'\n\n', d.details,
    case when d.due_on <> d.nominal_due_on then 'Moved from ' || to_char(d.nominal_due_on, 'FMDay, FMMonth FMDD') || ' (weekend or holiday).' end,
    'Track it on Admin, Compliance. Only administrators see this event.');
  v_start := (d.due_on::timestamp at time zone 'UTC');
  if d.event_id is not null and exists (select 1 from public.events where id = d.event_id) then
    update public.events set title = v_title, description = v_desc, starts_at = v_start, ends_at = null, all_day = true,
      audience = 'admins', class_id = null, send_reminders = false, updated_at = now()
    where id = d.event_id
      and (title, coalesce(description, ''), starts_at, all_day, audience, send_reminders)
          is distinct from (v_title, v_desc, v_start, true, 'admins'::public.audience, false);
  else
    insert into public.events (title, description, starts_at, ends_at, all_day, audience, class_id, send_reminders, managed_by)
    values (v_title, v_desc, v_start, null, true, 'admins', null, false, 'compliance')
    returning id into v_event;
    update public.compliance_deadlines set event_id = v_event where id = d.id;
  end if;
end;
$function$;

-- --- regenerate -------------------------------------------------------------------------------
-- Brings the generated deadlines in line with the rules and settings. Safe to run any number of
-- times: a second run with nothing changed touches no row.
--   * new occurrences are added (with their event);
--   * an open occurrence whose title, details or date changed is updated (filed and "not
--     needed" ones are history and stay as they were);
--   * a future occurrence the rules no longer give is deleted if nothing was recorded on it,
--     or retired (kept, off the calendar) if it was in progress;
--   * past deadlines are never touched.
create or replace function private.sync_compliance_deadlines(p_today date default (now() at time zone 'America/Chicago')::date)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_added integer := 0; v_changed integer := 0; v_removed integer := 0; v_retired integer := 0;
  r record;
  v_id uuid;
begin
  -- Serialise runs (the nightly job, a settings change and a vault edit can coincide).
  perform pg_advisory_xact_lock(hashtext('compliance_deadlines_sync'));

  for r in select * from private.compliance_desired(p_today) loop
    select id into v_id from public.compliance_deadlines where rule_key = r.rule_key and occurrence_key = r.occurrence_key;
    if v_id is null then
      insert into public.compliance_deadlines (rule_key, occurrence_key, title, details, period_label, nominal_due_on, due_on, source_url, vault_record_id)
      values (r.rule_key, r.occurrence_key, r.title, r.details, r.period_label, r.nominal_due_on, r.due_on, r.source_url, r.vault_record_id)
      returning id into v_id;
      v_added := v_added + 1;
      perform private.compliance_sync_event(v_id);
    else
      update public.compliance_deadlines set title = r.title, details = r.details, period_label = r.period_label,
        nominal_due_on = r.nominal_due_on, due_on = r.due_on, source_url = r.source_url, retired_at = null, updated_at = now()
      where id = v_id and status in ('not_started', 'in_progress')
        and ((title, details, period_label, nominal_due_on, due_on, source_url)
              is distinct from (r.title, r.details, r.period_label, r.nominal_due_on, r.due_on, r.source_url)
             or retired_at is not null);
      if found then v_changed := v_changed + 1; end if;
      perform private.compliance_sync_event(v_id);
    end if;
  end loop;

  -- Future generated deadlines the rules no longer give.
  for r in
    select d.id, d.status, d.event_id from public.compliance_deadlines d
    where d.rule_key is not null and d.retired_at is null and d.due_on >= p_today
      and d.status in ('not_started', 'in_progress')
      and not exists (select 1 from private.compliance_desired(p_today) x where x.rule_key = d.rule_key and x.occurrence_key = d.occurrence_key)
  loop
    if r.status = 'not_started' then
      delete from public.compliance_deadlines where id = r.id;
      if r.event_id is not null then delete from public.events where id = r.event_id; end if;
      v_removed := v_removed + 1;
    else
      update public.compliance_deadlines set retired_at = now(), updated_at = now() where id = r.id;
      perform private.compliance_sync_event(r.id);
      v_retired := v_retired + 1;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed, 'retired', v_retired);
end;
$function$;

-- A vault record's expiry date, title or archive state changed: renewals follow at once.
create or replace function private.org_records_compliance_sync()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' and new.expires_on is null then return null; end if;
  if tg_op = 'UPDATE' and (new.expires_on, new.title, new.issuer, new.archived_at is null)
      is not distinct from (old.expires_on, old.title, old.issuer, old.archived_at is null) then
    return null;
  end if;
  perform private.sync_compliance_deadlines();
  return null;
end;
$function$;

drop trigger if exists org_records_compliance_sync on public.org_records;
create trigger org_records_compliance_sync
  after insert or update on public.org_records
  for each row execute function private.org_records_compliance_sync();

-- --- reminders -----------------------------------------------------------------------------------
-- 60, 30 and 7 days before each open deadline, to every active administrator (never a reviewer
-- account). A reminder is sent on its day or, if the job missed it, up to two days late, but
-- only while no later reminder is due, and never for a reminder day that was already past when
-- the deadline was created. The log's key makes a second run send nothing.
create or replace function private.run_compliance_reminders(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_today date := (p_now at time zone 'America/Chicago')::date;
  v_logged integer; v_notified integer;
begin
  with admins as (
    select p.id as user_id from public.profiles p
    where p.status = 'active' and not p.is_demo and lower(coalesce(p.email, '')) not like '%@demo.veritasvillage.org'
      and exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'admin')),
  due as (
    select d.id as deadline_id, o.off, d.due_on
    from public.compliance_deadlines d
    cross join unnest(array[60, 30, 7]) as o(off)
    where d.retired_at is null and d.status in ('not_started', 'in_progress')
      and v_today between d.due_on - o.off and d.due_on - o.off + 2
      and v_today < d.due_on
      and d.due_on - o.off >= (d.created_at at time zone 'America/Chicago')::date
      and not exists (select 1 from unnest(array[60, 30, 7]) as o2(off) where o2.off < o.off and v_today >= d.due_on - o2.off)),
  fresh as (
    insert into public.compliance_deadline_reminder_log (deadline_id, offset_days, due_on, user_id, sent_at)
    select due.deadline_id, due.off, due.due_on, a.user_id, p_now from due cross join admins a
    on conflict do nothing
    returning deadline_id, offset_days, due_on, user_id),
  ins as (
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select f.user_id, 'compliance_deadline',
      left('In ' || (f.due_on - v_today) || ' days: ' || d.title, 200),
      left('Due ' || to_char(f.due_on, 'FMDay, FMMonth FMDD, YYYY')
           || case d.status when 'in_progress' then '. Marked in progress.' else '. Not started yet.' end
           || ' Open Admin, Compliance to see what is needed.', 400),
      '/family-village/admin?tab=deadlines', 'compliance_deadline', d.id
    from fresh f join public.compliance_deadlines d on d.id = f.deadline_id
    returning 1)
  select (select count(*) from fresh), (select count(*) from ins) into v_logged, v_notified;
  return jsonb_build_object('reminders', v_logged, 'notifications', v_notified);
end;
$function$;

create or replace function private.run_compliance_nightly(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
begin
  return jsonb_build_object(
    'deadlines', private.sync_compliance_deadlines((p_now at time zone 'America/Chicago')::date),
    'reminders', private.run_compliance_reminders(p_now));
end;
$function$;

-- Deadline reminders are worth an email when push goes unseen.
update public.notification_settings
set email_fallback_kinds = array_append(email_fallback_kinds, 'compliance_deadline')
where id = 'ladder' and not ('compliance_deadline' = any (email_fallback_kinds));

-- --- what administrators can do --------------------------------------------------------------------
-- The rules with whether each is on now and its next due date.
create or replace function public.admin_compliance_rules()
returns table (key text, title text, description text, applies_to text, date_rule text, roll_forward boolean,
               source_label text, source_url text, optional boolean, default_on boolean, needs_check boolean,
               needs text, is_on boolean, next_due_on date)
language plpgsql stable security definer set search_path to ''
as $function$
declare s public.compliance_settings;
begin
  perform private.require_records_admin();
  select * into s from public.compliance_settings where id = 'org';
  return query
  select r.key, r.title, r.description, r.applies_to, r.date_rule, r.roll_forward, r.source_label, r.source_url,
    r.optional, r.default_on, r.needs_check, r.needs, private.compliance_rule_on(r.key, s),
    (select min(d.due_on) from public.compliance_deadlines d
      where d.rule_key = r.key and d.retired_at is null and d.status in ('not_started', 'in_progress')
        and d.due_on >= (now() at time zone 'America/Chicago')::date)
  from private.compliance_rule_catalog() r
  order by r.sort_order;
end;
$function$;

create or replace function public.admin_update_compliance_settings(
  p_fiscal_year_end_month integer, p_has_employees boolean, p_pays_contractors boolean, p_gross_receipts_size text,
  p_rule_switches jsonb, p_board_meeting_month integer, p_board_meeting_day integer,
  p_handbook_month integer, p_handbook_day integer)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_switches jsonb := '{}'::jsonb;
  k text; v jsonb;
begin
  if p_fiscal_year_end_month is null or p_fiscal_year_end_month not between 1 and 12 then raise exception 'Choose the month the fiscal year ends.'; end if;
  if p_gross_receipts_size is null or p_gross_receipts_size not in ('up_to_50k', 'under_200k', '200k_or_more') then raise exception 'Choose the usual size of gross receipts.'; end if;
  if coalesce(p_board_meeting_month, 0) not between 1 and 12 or coalesce(p_board_meeting_day, 0) not between 1 and 31
     or coalesce(p_handbook_month, 0) not between 1 and 12 or coalesce(p_handbook_day, 0) not between 1 and 31 then
    raise exception 'Choose a month and day for the board meeting and the handbook refresh.';
  end if;
  if p_rule_switches is not null then
    if jsonb_typeof(p_rule_switches) <> 'object' then raise exception 'The rule switches are not in the right shape.'; end if;
    for k, v in select * from jsonb_each(p_rule_switches) loop
      if jsonb_typeof(v) <> 'boolean' or not exists (select 1 from private.compliance_rule_catalog() r where r.key = k and r.optional) then
        raise exception 'Only the optional rules can be switched on or off.';
      end if;
      v_switches := v_switches || jsonb_build_object(k, v);
    end loop;
  end if;

  update public.compliance_settings set
    fiscal_year_end_month = p_fiscal_year_end_month, has_employees = coalesce(p_has_employees, false),
    pays_contractors = coalesce(p_pays_contractors, false), gross_receipts_size = p_gross_receipts_size,
    rule_switches = v_switches, board_meeting_month = p_board_meeting_month, board_meeting_day = p_board_meeting_day,
    handbook_month = p_handbook_month, handbook_day = p_handbook_day, updated_at = now(), updated_by = v_actor
  where id = 'org';

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'compliance_settings_updated', 'compliance_settings', 'org',
    jsonb_build_object('fiscal_year_end_month', p_fiscal_year_end_month, 'has_employees', coalesce(p_has_employees, false),
      'pays_contractors', coalesce(p_pays_contractors, false), 'gross_receipts_size', p_gross_receipts_size, 'rule_switches', v_switches));

  return private.sync_compliance_deadlines();
end;
$function$;

create or replace function public.admin_regenerate_compliance_deadlines()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.require_records_admin();
  return private.sync_compliance_deadlines();
end;
$function$;

-- Status, and the filing details when it is filed. p_record is a records-vault record the
-- browser has already created (and uploaded the file to) through the vault's own functions.
create or replace function public.admin_set_compliance_status(
  p_deadline uuid, p_status text, p_filed_on date, p_confirmation text, p_record uuid, p_note text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  d public.compliance_deadlines;
  v_today date := (now() at time zone 'America/Chicago')::date;
begin
  select * into d from public.compliance_deadlines where id = p_deadline for update;
  if not found then raise exception 'That deadline does not exist.'; end if;
  if p_status is null or p_status not in ('not_started', 'in_progress', 'filed', 'not_needed') then raise exception 'Choose a status.'; end if;
  if p_status = 'filed' then
    if p_filed_on is null then raise exception 'Enter the date it was filed.'; end if;
    if p_filed_on > v_today + 1 then raise exception 'The filing date cannot be in the future.'; end if;
  end if;
  if p_record is not null and not exists (select 1 from public.org_records o where o.id = p_record and o.archived_at is null) then
    raise exception 'That records-vault document does not exist.';
  end if;
  if p_status = 'not_needed' and coalesce(btrim(p_note), '') = '' then raise exception 'Say why it is not needed this year.'; end if;

  update public.compliance_deadlines set
    status = p_status,
    filed_on = case when p_status = 'filed' then p_filed_on end,
    confirmation_number = case when p_status = 'filed' then nullif(left(btrim(coalesce(p_confirmation, '')), 120), '') end,
    record_id = coalesce(p_record, case when p_status = 'filed' then record_id end),
    status_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    updated_at = now(), updated_by = v_actor
  where id = p_deadline;
  perform private.compliance_sync_event(p_deadline);

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'compliance_status_set', 'compliance_deadline', p_deadline::text,
    jsonb_build_object('from', d.status, 'to', p_status, 'filed_on', p_filed_on, 'has_confirmation', coalesce(btrim(p_confirmation), '') <> '', 'record_id', p_record));
end;
$function$;

-- Add (p_id null) or change a deadline of the administrator's own. Generated ones cannot be
-- edited here; their rules and settings decide them.
create or replace function public.admin_save_custom_deadline(
  p_id uuid, p_title text, p_due_on date, p_details text, p_source_url text, p_roll_forward boolean default false)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_id uuid := p_id;
  v_due date;
  v_url text := nullif(btrim(coalesce(p_source_url, '')), '');
begin
  if coalesce(btrim(p_title), '') = '' then raise exception 'Give the deadline a title.'; end if;
  if char_length(btrim(p_title)) > 200 then raise exception 'Keep the title under 200 characters.'; end if;
  if p_due_on is null then raise exception 'Choose the due date.'; end if;
  if v_url is not null and v_url !~ '^https://' then raise exception 'A source link must start with https://.'; end if;
  v_due := case when coalesce(p_roll_forward, false) then private.roll_forward(p_due_on) else p_due_on end;

  if v_id is null then
    insert into public.compliance_deadlines (title, details, nominal_due_on, due_on, source_url, created_by, updated_by)
    values (btrim(p_title), nullif(left(btrim(coalesce(p_details, '')), 2000), ''), p_due_on, v_due, v_url, v_actor, v_actor)
    returning id into v_id;
  else
    update public.compliance_deadlines set title = btrim(p_title), details = nullif(left(btrim(coalesce(p_details, '')), 2000), ''),
      nominal_due_on = p_due_on, due_on = v_due, source_url = v_url, updated_at = now(), updated_by = v_actor
    where id = v_id and rule_key is null;
    if not found then raise exception 'Only deadlines you added can be changed here.'; end if;
  end if;
  perform private.compliance_sync_event(v_id);

  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, case when p_id is null then 'compliance_custom_added' else 'compliance_custom_changed' end, 'compliance_deadline', v_id::text,
    jsonb_build_object('due_on', v_due));
  return v_id;
end;
$function$;

create or replace function public.admin_delete_custom_deadline(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  d public.compliance_deadlines;
begin
  select * into d from public.compliance_deadlines where id = p_id and rule_key is null;
  if not found then raise exception 'Only deadlines you added can be deleted.'; end if;
  if d.status = 'filed' then raise exception 'A filed deadline is kept in the history.'; end if;
  delete from public.compliance_deadlines where id = p_id;
  if d.event_id is not null then delete from public.events where id = d.event_id; end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'compliance_custom_deleted', 'compliance_deadline', p_id::text, jsonb_build_object('title', d.title, 'due_on', d.due_on));
end;
$function$;

-- --- access -----------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'private.nth_weekday(integer,integer,integer,integer)', 'private.observed_day(date)', 'private.us_legal_holidays(integer)',
    'private.is_business_day(date)', 'private.roll_forward(date)', 'private.fiscal_year_end(integer,integer)',
    'private.annual_return_due(integer,integer)', 'private.clamped_date(integer,integer,integer)',
    'private.compliance_rule_catalog()', 'private.compliance_rule_on(text,public.compliance_settings)',
    'private.compliance_desired(date)', 'private.compliance_sync_event(uuid)', 'private.sync_compliance_deadlines(date)',
    'private.org_records_compliance_sync()', 'private.run_compliance_reminders(timestamptz)', 'private.run_compliance_nightly(timestamptz)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'admin_compliance_rules()',
    'admin_update_compliance_settings(integer,boolean,boolean,text,jsonb,integer,integer,integer,integer)',
    'admin_regenerate_compliance_deadlines()', 'admin_set_compliance_status(uuid,text,date,text,uuid,text)',
    'admin_save_custom_deadline(uuid,text,date,text,text,boolean)', 'admin_delete_custom_deadline(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- --- first run and schedule --------------------------------------------------------------------------
select private.sync_compliance_deadlines();

create extension if not exists pg_cron;
select cron.unschedule('compliance-deadlines')
where exists (select 1 from cron.job where jobname = 'compliance-deadlines');
-- 13:00 UTC: 7:00 AM Central in winter, 8:00 AM in summer.
select cron.schedule('compliance-deadlines', '0 13 * * *', $$ select private.run_compliance_nightly(); $$);
