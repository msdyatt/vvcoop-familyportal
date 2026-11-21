-- Compliance calendar: admin-only events and deadlines, the date rules (with weekend and holiday
-- roll-forward), idempotent generation from the settings, and 60/30/7-day admin reminders.
-- Fixtures: A1 administrator; A3 administrator with a second factor; T1 teacher; P1 parent;
-- D1 a reviewer (demo) account that also has the admin role.
-- Generation is run with an explicit "today" (2026-11-21), so most checks do not depend on the
-- day the tests run; the vault and reminder checks use dates relative to the real today.
begin;
select plan(128);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e1', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a3', 'admin'),
  ('00000000-0000-0000-0000-0000000000e1', 'teacher'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000d1', 'admin');
-- Since admin permissions (20261121160000), board-only areas need a board admin.
insert into public.admin_tiers (user_id, tier) select user_id, 'board' from public.user_roles where role = 'admin' on conflict do nothing;
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());

-- Start from nothing: the migration already generated deadlines for the real today.
delete from public.compliance_deadlines;
select is((select count(*)::int from public.events where managed_by = 'compliance'), 0, 'deleting a deadline deletes its calendar event');

-- ---- who may call what ---------------------------------------------------------------------------
select ok('admins' = any (enum_range(null::public.audience)::text[]), 'events have an admins-only audience');
select ok(not has_function_privilege('anon', 'public.admin_update_compliance_settings(integer,boolean,boolean,text,jsonb,integer,integer,integer,integer)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_set_compliance_status(uuid,text,date,text,uuid,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_compliance_rules()', 'EXECUTE'), 'visitors cannot call the compliance functions');
select ok(not has_function_privilege('authenticated', 'private.sync_compliance_deadlines(date)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.run_compliance_reminders(timestamptz)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.compliance_sync_event(uuid)', 'EXECUTE'), 'signed-in people cannot run the generator or the reminders');
select ok(not has_table_privilege('authenticated', 'public.compliance_deadlines', 'INSERT')
          and not has_table_privilege('authenticated', 'public.compliance_deadlines', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.compliance_deadlines', 'DELETE')
          and not has_table_privilege('authenticated', 'public.compliance_settings', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.compliance_deadline_reminder_log', 'INSERT'), 'nobody writes the compliance tables directly');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.admin_set_compliance_status(uuid,text,date,text,uuid,text)'::regprocedure),
          'the admin functions are security definer with an empty search path');

-- ---- the date rules --------------------------------------------------------------------------------
select is(private.roll_forward('2026-05-15'), '2026-05-15'::date, 'a Friday due date stays put');
select is(private.roll_forward('2027-05-15'), '2027-05-17'::date, 'a Saturday moves to Monday');
select is(private.roll_forward('2027-01-31'), '2027-02-01'::date, 'a Sunday moves to Monday');
select is(private.roll_forward('2026-01-31'), '2026-02-02'::date, 'a Saturday 31 January moves to Monday 2 February');
select is(private.roll_forward('2027-05-31'), '2027-06-01'::date, 'Memorial Day moves to the next day');
select is(private.roll_forward('2027-06-18'), '2027-06-21'::date, 'Juneteenth observed on Friday moves to Monday');
select is(private.roll_forward('2027-12-31'), '2028-01-03'::date, 'New Year''s Day observed on 31 December moves past the weekend');
select is(private.roll_forward('2028-04-15'), '2028-04-18'::date, 'DC Emancipation Day observed on Monday pushes a Saturday due date to Tuesday');
select is(private.roll_forward('2022-04-15'), '2022-04-18'::date, 'DC Emancipation Day observed on Friday 15 April moves to Monday');
select is(private.roll_forward('2027-02-15'), '2027-02-16'::date, 'Washington''s Birthday moves to the next day');
select is(private.roll_forward('2026-11-26'), '2026-11-27'::date, 'Thanksgiving moves to the Friday');
select is((select count(*)::int from private.us_legal_holidays(2026)), 12, '2026 has 11 federal holidays and Emancipation Day');
select is((select count(*)::int from private.us_legal_holidays(2027)), 13, '2027 also has 31 December (New Year''s Day 2028 observed)');
select is((select count(*)::int from private.us_legal_holidays(2028)), 11, '2028 has no New Year''s Day of its own (it was observed in 2027)');
select ok('2026-07-03'::date in (select * from private.us_legal_holidays(2026)), 'Independence Day on a Saturday is observed on Friday');
select is(private.annual_return_due(12, 2026), '2027-05-15'::date, 'calendar year: the return is due 15 May');
select is(private.annual_return_due(6, 2026), '2026-11-15'::date, 'a 30 June year end: due 15 November');
select is(private.roll_forward(private.annual_return_due(6, 2026)), '2026-11-16'::date, 'and 15 November 2026 is a Sunday, so the 16th');
select is(private.annual_return_due(8, 2026), '2027-01-15'::date, 'a 31 August year end: due 15 January of the next year');
select is(private.roll_forward(private.annual_return_due(9, 2026)), '2027-02-16'::date, 'a 30 September year end lands on Washington''s Birthday 2027 and moves');
select is(private.fiscal_year_end(2, 2028), '2028-02-29'::date, 'a February year end ends on the last day, leap years included');
select is(private.clamped_date(2027, 6, 31), '2027-06-30'::date, 'a day past the month end is pulled back to it');

-- ---- generation, from the default settings ---------------------------------------------------------
select is(private.sync_compliance_deadlines('2026-11-21') ->> 'removed', '0', 'the first run removes nothing');
select ok((select count(*) from public.compliance_deadlines) > 0, 'the first run adds deadlines');
select is((select due_on from public.compliance_deadlines where rule_key = 'irs_annual_return' and occurrence_key = 'FY2026-12-31'),
          '2027-05-17'::date, 'the 2026 return is due Monday 17 May 2027 (15 May is a Saturday)');
select is((select nominal_due_on from public.compliance_deadlines where rule_key = 'irs_annual_return' and occurrence_key = 'FY2026-12-31'),
          '2027-05-15'::date, 'and the rule''s own date is kept');
select matches((select title from public.compliance_deadlines where occurrence_key = 'FY2026-12-31' and rule_key = 'irs_annual_return'),
               '^IRS Form 990-N \(e-Postcard\) for the year ending December 31, 2026$', 'a small co-op''s return is named as the 990-N');
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'irs_annual_return'), 2, 'two returns fall in the next 18 months (2026 and 2027 years)');
select is((select count(*)::int from public.compliance_deadlines where due_on < '2026-11-21' or due_on > '2028-05-21'), 0, 'nothing is generated outside the 18 months');
select is((select count(*)::int from public.compliance_deadlines where rule_key in ('irs_1099_nec', 'irs_941', 'irs_w2', 'tx_twc_wage_report')), 0,
          'no contractor or payroll deadlines without contractors or employees');
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'irs_990t'), 0, 'the optional 990-T is off by default');
select is((select due_on from public.compliance_deadlines where rule_key = 'tx_franchise_exemption' and occurrence_key = '2027'), '2027-05-17'::date,
          'the Texas franchise item is on, as a check, and rolls forward too');
select is((select due_on from public.compliance_deadlines where rule_key = 'annual_board_meeting' and occurrence_key = '2027'), '2027-01-31'::date,
          'the board meeting is on the set day and is not moved for the weekend');
select is((select due_on from public.compliance_deadlines where rule_key = 'handbook_waiver_refresh' and occurrence_key = '2027'), '2027-07-15'::date,
          'the handbook refresh is on its set day');
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'tx_sos_periodic_report'), 0, 'the on-notice Secretary of State report is never generated');
select is((select count(*)::int from public.compliance_deadlines d join public.events e on e.id = d.event_id
           where e.audience = 'admins' and e.managed_by = 'compliance' and e.all_day and not e.send_reminders and e.class_id is null),
          (select count(*)::int from public.compliance_deadlines), 'every deadline has an admin-only all-day calendar event');
select is((select starts_at from public.events e join public.compliance_deadlines d on d.event_id = e.id where d.occurrence_key = 'FY2026-12-31' and d.rule_key = 'irs_annual_return'),
          '2027-05-17 00:00:00+00'::timestamptz, 'the event is on the due date (all-day, stored at UTC midnight)');
select matches((select e.title from public.events e join public.compliance_deadlines d on d.event_id = e.id where d.occurrence_key = 'FY2026-12-31' and d.rule_key = 'irs_annual_return'),
               '^Due: ', 'the event title says it is due');

-- idempotent
create temp table snap as select id, rule_key, occurrence_key, due_on, title, event_id from public.compliance_deadlines;
select is(private.sync_compliance_deadlines('2026-11-21'), '{"added": 0, "changed": 0, "removed": 0, "retired": 0}'::jsonb, 'a second run changes nothing');
select is((select count(*)::int from public.compliance_deadlines), (select count(*)::int from snap), 'and adds no duplicate');
select is((select count(*)::int from public.compliance_deadlines d join snap s using (id) where (d.due_on, d.title, d.event_id) is not distinct from (s.due_on, s.title, s.event_id)),
          (select count(*)::int from snap), 'and keeps every row and event as it was');
select is((select count(*)::int from public.events where managed_by = 'compliance'), (select count(*)::int from snap), 'and makes no second event');

-- settings change: contractors
update public.compliance_settings set pays_contractors = true;
select is(private.sync_compliance_deadlines('2026-11-21') ->> 'added', '2', 'paying contractors adds two 1099-NEC deadlines');
select is((select due_on from public.compliance_deadlines where rule_key = 'irs_1099_nec' and occurrence_key = 'CY2026'), '2027-02-01'::date,
          'the 2026 forms are due Monday 1 February 2027 (31 January is a Sunday)');
select matches((select details from public.compliance_deadlines where rule_key = 'irs_1099_nec' and occurrence_key = 'CY2026'), 'Threshold for these payments: \$2,000\.',
               'the 2026 payments use the $2,000 threshold');
update public.compliance_deadlines set status = 'in_progress' where rule_key = 'irs_1099_nec' and occurrence_key = 'CY2027';
update public.compliance_settings set pays_contractors = false;
select is(private.sync_compliance_deadlines('2026-11-21'), '{"added": 0, "changed": 0, "removed": 1, "retired": 1}'::jsonb,
          'switching contractors off removes the untouched deadline and retires the one in progress');
select ok((select retired_at is not null and event_id is null from public.compliance_deadlines where rule_key = 'irs_1099_nec' and occurrence_key = 'CY2027'),
          'the retired deadline is kept for the history, off the calendar');
update public.compliance_settings set pays_contractors = true;
select is(private.sync_compliance_deadlines('2026-11-21'), '{"added": 1, "changed": 1, "removed": 0, "retired": 0}'::jsonb,
          'switching back adds the removed one and brings back the retired one');
select ok((select retired_at is null and event_id is not null and status = 'in_progress' from public.compliance_deadlines where rule_key = 'irs_1099_nec' and occurrence_key = 'CY2027'),
          'with its progress and a new event');

-- settings change: employees
update public.compliance_settings set has_employees = true;
select ok((private.sync_compliance_deadlines('2026-11-21') ->> 'added')::int > 0, 'having employees adds the payroll deadlines');
select is((select due_on from public.compliance_deadlines where rule_key = 'irs_941' and occurrence_key = '2027-Q3'), '2027-11-01'::date,
          'Form 941 for Q3 2027 is due Monday 1 November (31 October is a Sunday)');
select is((select due_on from public.compliance_deadlines where rule_key = 'irs_941' and occurrence_key = '2027-Q2'), '2027-08-02'::date,
          'and Q2 is due Monday 2 August (31 July is a Saturday)');
select ok(exists (select 1 from public.compliance_deadlines where rule_key = 'tx_twc_wage_report'), 'the Texas wage report (a check item) comes with employees');
update public.compliance_settings set has_employees = false, rule_switches = '{"tx_twc_wage_report": false}';
select private.sync_compliance_deadlines('2026-11-21');
select is((select count(*)::int from public.compliance_deadlines where rule_key in ('irs_941', 'irs_w2', 'tx_twc_wage_report')), 0, 'and they go when employees do');

-- settings change: fiscal year end
update public.compliance_settings set fiscal_year_end_month = 6;
select private.sync_compliance_deadlines('2026-11-21');
select is((select array_agg(occurrence_key order by occurrence_key) from public.compliance_deadlines where rule_key = 'irs_annual_return'),
          array['FY2027-06-30'], 'a 30 June year end leaves one return in the window');
select is((select due_on from public.compliance_deadlines where rule_key = 'irs_annual_return'), '2027-11-15'::date, 'due 15 November 2027');
update public.compliance_settings set fiscal_year_end_month = 12, gross_receipts_size = 'under_200k';
select private.sync_compliance_deadlines('2026-11-21');
select matches((select e.title from public.events e join public.compliance_deadlines d on d.event_id = e.id where d.rule_key = 'irs_annual_return' and d.occurrence_key = 'FY2026-12-31'),
               '^Due: IRS Form 990-EZ ', 'a larger co-op''s event is renamed to the 990-EZ');

-- optional rule switched on
update public.compliance_settings set rule_switches = '{"irs_990t": true}';
select private.sync_compliance_deadlines('2026-11-21');
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'irs_990t'), 2, 'switching on the 990-T adds it for both years');
update public.compliance_settings set rule_switches = '{"tx_franchise_exemption": false, "handbook_waiver_refresh": false}';
select private.sync_compliance_deadlines('2026-11-21');
select is((select count(*)::int from public.compliance_deadlines where rule_key in ('irs_990t', 'tx_franchise_exemption', 'handbook_waiver_refresh')), 0,
          'switching optional rules off removes their untouched deadlines');
update public.compliance_settings set rule_switches = '{}', gross_receipts_size = 'up_to_50k';
select private.sync_compliance_deadlines('2026-11-21');
select is(private.sync_compliance_deadlines('2026-11-21'), '{"added": 0, "changed": 0, "removed": 0, "retired": 0}'::jsonb, 'after all that, a repeat run is still a no-op');

-- ---- visibility: nobody but administrators --------------------------------------------------------
-- A hand-made admin-only event (not managed) for the reminder recipients check.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into public.events (title, starts_at, all_day, audience) values ('Board dinner', '2027-03-01', true, 'admins')$$,
                'an administrator can add an admin-only event of their own');
select ok((select count(*) from public.events where audience = 'admins') > 1, 'an administrator sees admin-only events');
select is((select count(*)::int from public.compliance_deadlines), (select count(*)::int from public.events where managed_by = 'compliance'), 'and every deadline');
select ok(exists (select 1 from public.compliance_settings), 'and the settings');
select ok((select count(*) from public.admin_compliance_rules()) = 12, 'and the rules list');
select throws_ok($$update public.events set audience = 'families' where managed_by = 'compliance'$$, '42501', 'This deadline is managed on Admin, Compliance.',
                 'an administrator cannot re-audience a deadline event directly');
select throws_ok($$delete from public.events where managed_by = 'compliance'$$, '42501', 'This deadline is managed on Admin, Compliance.',
                 'or delete one');
select throws_ok($$insert into public.events (title, starts_at, audience, managed_by) values ('Fake', now(), 'admins', 'compliance')$$, '42501', null,
                 'or make one that claims to be managed');
reset role;

select is((select array_agg(user_id order by user_id) from private.event_recipients((select id from public.events where title = 'Board dinner'))),
          array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3']::uuid[],
          'event reminders for an admin-only event go to the active administrators only (not teachers, parents or reviewer accounts)');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where audience = 'admins'), 0, 'a parent sees no admin-only event');
select is((select count(*)::int from public.events where managed_by = 'compliance'), 0, 'not even by asking for managed events');
select is((select count(*)::int from public.compliance_deadlines), 0, 'and no deadline');
select is((select count(*)::int from public.compliance_settings), 0, 'and no settings');
select throws_ok($$select * from public.admin_compliance_rules()$$, '42501', 'Administrator access is required.', 'and cannot read the rules list');
select throws_ok($$select public.admin_regenerate_compliance_deadlines()$$, '42501', 'Administrator access is required.', 'or regenerate');
select throws_ok($$insert into public.events (title, starts_at, audience) values ('Sneaky', now(), 'admins')$$, '42501', null, 'or add an admin-only event');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where audience = 'admins'), 0, 'a teacher sees no admin-only event');
select is((select count(*)::int from public.compliance_deadlines), 0, 'and no deadline');
select throws_ok($$select public.admin_save_custom_deadline(null, 'X', '2027-01-01', null, null, false)$$, '42501', 'Administrator access is required.', 'and cannot add one');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where audience = 'admins'), 0, 'a reviewer account with the admin role sees no admin-only event');
select is((select count(*)::int from public.compliance_deadlines), 0, 'and no deadline');
select throws_ok($$select * from public.admin_compliance_rules()$$, '42501', 'Administrator access is required.', 'and is refused by the functions');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::int from public.events where audience = 'admins'), 0, 'an administrator who has not passed the second factor sees no admin-only event');
select is((select count(*)::int from public.compliance_deadlines), 0, 'and no deadline');
select throws_ok($$select * from public.admin_compliance_rules()$$, '42501', 'Complete two-factor verification before continuing.', 'and is asked for the second factor');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select ok((select count(*) from public.events where audience = 'admins') > 0, 'after the second factor, they see them');
reset role;

select throws_ok($$insert into public.events (title, starts_at, audience, class_id) values ('X', now(), 'admins', gen_random_uuid())$$, '23514', null,
                 'an admin-only event cannot belong to a class');
select throws_ok($$insert into public.posts (author_user_id, title, body, audience) values ('00000000-0000-0000-0000-0000000000a1', 'X', 'Y', 'admins')$$, '23514', null,
                 'a news post can never use the admin-only audience');

-- ---- what administrators do ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_compliance_settings(12, false, false, 'up_to_50k', '{"irs_annual_return": false}', 1, 31, 7, 15)$$,
                 'P0001', 'Only the optional rules can be switched on or off.', 'the annual return cannot be switched off');
select throws_ok($$select public.admin_update_compliance_settings(13, false, false, 'up_to_50k', '{}', 1, 31, 7, 15)$$,
                 'P0001', 'Choose the month the fiscal year ends.', 'the fiscal year end must be a month');
select lives_ok($$select public.admin_update_compliance_settings(12, false, true, 'up_to_50k', '{"conflict_of_interest": false}', 2, 15, 7, 15)$$, 'an administrator saves the settings');
select ok(exists (select 1 from public.audit_log where action = 'compliance_settings_updated' and actor_user_id = '00000000-0000-0000-0000-0000000000a1'), 'and it is in the audit log');
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'conflict_of_interest' and retired_at is null), 0, 'and the deadlines follow at once');

select throws_ok(format($$select public.admin_set_compliance_status(%L, 'filed', null, null, null, null)$$,
                        (select id from public.compliance_deadlines where rule_key = 'irs_annual_return' order by due_on limit 1)),
                 'P0001', 'Enter the date it was filed.', 'filing needs a date');
select throws_ok(format($$select public.admin_set_compliance_status(%L, 'not_needed', null, null, null, '  ')$$,
                        (select id from public.compliance_deadlines where rule_key = 'irs_annual_return' order by due_on limit 1)),
                 'P0001', 'Say why it is not needed this year.', '"not needed" needs a reason');
select lives_ok(format($$select public.admin_set_compliance_status(%L, 'filed', current_date, 'ABC-123', null, null)$$,
                       (select id from public.compliance_deadlines where rule_key = 'irs_annual_return' order by due_on limit 1)), 'an administrator marks a return filed');
select is((select confirmation_number from public.compliance_deadlines where rule_key = 'irs_annual_return' order by due_on limit 1), 'ABC-123', 'with its confirmation number');
select matches((select e.title from public.events e join public.compliance_deadlines d on d.event_id = e.id where d.rule_key = 'irs_annual_return' order by d.due_on limit 1),
               '^Filed: ', 'and the calendar shows it filed');
select throws_ok(format($$select public.admin_save_custom_deadline(%L, 'Changed', '2027-01-01', null, null, false)$$,
                        (select id from public.compliance_deadlines where rule_key = 'irs_annual_return' order by due_on limit 1)),
                 'P0001', 'Only deadlines you added can be changed here.', 'a generated deadline cannot be edited by hand');
select throws_ok($$select public.admin_save_custom_deadline(null, 'Grant report', '2027-03-01', null, 'http://example.com', false)$$,
                 'P0001', 'A source link must start with https://.', 'a source link must be https');
select lives_ok($$select public.admin_save_custom_deadline(null, 'Grant report', '2027-05-15', 'For the county grant', 'https://example.com/grant', true)$$,
                'an administrator adds a custom deadline');
select is((select due_on from public.compliance_deadlines where title = 'Grant report'), '2027-05-17'::date, 'with roll-forward if asked for');
select is((select e.audience::text from public.events e join public.compliance_deadlines d on d.event_id = e.id where d.title = 'Grant report'), 'admins',
          'and it is on the calendar for administrators only');
select lives_ok(format($$select public.admin_delete_custom_deadline(%L)$$, (select id from public.compliance_deadlines where title = 'Grant report')), 'and can delete it');
select is((select count(*)::int from public.events where title = 'Due: Grant report'), 0, 'which takes its event with it');
reset role;

-- ---- renewals from the records vault (relative to the real today) ----------------------------------------
insert into public.org_records (id, title, category, issuer, expires_on)
values ('00000000-0000-0000-0000-00000000c001', 'General liability', 'insurance', 'Church Mutual', current_date + 100);
select is((select due_on from public.compliance_deadlines where rule_key = 'vault_renewal'), current_date + 100, 'a vault record with an expiry date gets a renewal deadline at once');
select is((select title from public.compliance_deadlines where rule_key = 'vault_renewal'), 'Renew: General liability (Church Mutual)', 'named after the record');
update public.org_records set expires_on = current_date + 120 where id = '00000000-0000-0000-0000-00000000c001';
select is((select array_agg(due_on) from public.compliance_deadlines where rule_key = 'vault_renewal'), array[current_date + 120], 'a new expiry date moves it (no duplicate)');
update public.org_records set archived_at = now(), archive_reason = 'Replaced' where id = '00000000-0000-0000-0000-00000000c001';
select is((select count(*)::int from public.compliance_deadlines where rule_key = 'vault_renewal'), 0, 'archiving the record removes the renewal');

-- ---- reminders 60, 30 and 7 days before (relative to the real today) ----------------------------------------
delete from public.notifications;
insert into public.compliance_deadlines (title, nominal_due_on, due_on) values ('Sixty days out', current_date + 60, current_date + 60);
insert into public.compliance_deadlines (title, nominal_due_on, due_on, status, filed_on) values ('Already filed', current_date + 30, current_date + 30, 'filed', current_date);
insert into public.compliance_deadlines (title, nominal_due_on, due_on) values ('Fifty-eight days out', current_date + 58, current_date + 58);
-- the times below are noon Central on the days counted from the real today
create temp table t0 as select ((current_date::timestamp + interval '12 hours') at time zone 'America/Chicago') as noon;
select is((private.run_compliance_reminders((select noon from t0)) ->> 'notifications')::int, 2, 'on the 60-day mark, both active administrators are reminded');
select is((select array_agg(recipient_user_id order by recipient_user_id) from public.notifications where kind = 'compliance_deadline'),
          array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3']::uuid[], 'and only them');
select matches((select title from public.notifications where kind = 'compliance_deadline' limit 1), '^In 60 days: Sixty days out$', 'saying how far off it is');
select is((select link_path from public.notifications where kind = 'compliance_deadline' limit 1), '/family-village/admin?tab=deadlines', 'and linking to the Compliance page');
select is((private.run_compliance_reminders((select noon from t0)) ->> 'notifications')::int, 0, 'a second run the same day sends nothing');
select is((private.run_compliance_reminders((select noon + interval '10 days' from t0)) ->> 'notifications')::int, 0, 'nothing between the marks');
select is((private.run_compliance_reminders((select noon + interval '29 days' from t0)) ->> 'notifications')::int, 2,
          'a 30-day mark missed by a day is still sent (the 58-day deadline, whose mark was yesterday)');
select is((private.run_compliance_reminders((select noon + interval '30 days' from t0)) ->> 'notifications')::int, 2,
          'and the 60-day deadline gets its 30-day reminder on the day, once');
select is((private.run_compliance_reminders((select noon + interval '53 days' from t0)) ->> 'notifications')::int, 4,
          '7 days before: the 60-day deadline on the day, the 58-day one two days late');
select is((private.run_compliance_reminders((select noon + interval '54 days' from t0)) ->> 'notifications')::int, 0, 'and nothing more after that');
select is((select count(*)::int from public.notifications n join public.compliance_deadlines d on d.id = n.subject_id where d.title = 'Already filed'), 0,
          'a filed deadline is never reminded');
select is((select count(*)::int from public.compliance_deadline_reminder_log l join public.compliance_deadlines d on d.id = l.deadline_id where d.title = 'Fifty-eight days out' and l.offset_days = 60), 0,
          'a reminder day already past when the deadline was made is skipped');
select ok((select 'compliance_deadline' = any (email_fallback_kinds) from public.notification_settings where id = 'ladder'), 'unseen deadline reminders fall back to email');

select * from finish();
rollback;
