-- Year-end tax summary: administrators only, reviewer (demo) families left out, test-mode money
-- only while billing is in test mode, the fiscal year from the compliance settings, the 3-year
-- gross receipts, the 1099-NEC payee list with the year's threshold, and the 990-N key facts with
-- the EIN masked.
-- Fixtures: A1 administrator; A3 administrator with a second factor; P1 parent of F1; D1 reviewer
-- (demo) account with the admin role, in the reviewer family FD.
begin;
select plan(56);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a3', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000d1', 'admin');
-- Since admin permissions (20261121150000), board-only areas need a board admin.
insert into public.admin_tiers (user_id, tier) select user_id, 'board' from public.user_roles where role = 'admin' on conflict do nothing;
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000fd', 'Reviewers');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000fd', '00000000-0000-0000-0000-0000000000d1', 'Parent');

update public.billing_settings set provider = 'off' where id = 'dues';
update public.compliance_settings set fiscal_year_end_month = 12;

-- Dues: online, offline, a refund, a test-mode payment, a failed one, a reviewer family's, and two
-- in 2025 (one at 00:30 UTC on 1 January 2026, which is still 31 December in Texas).
insert into public.dues_payments (id, family_id, direction, amount_cents, method, status, source, livemode, occurred_at) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000f1', 'charge', 30000, 'card', 'succeeded', 'portal', true, '2026-03-01 15:00+00'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000f1', 'charge', 15000, 'check', 'succeeded', 'admin_manual', true, '2026-04-01 15:00+00'),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000f1', 'charge', 99999, 'card', 'succeeded', 'portal', false, '2026-06-01 15:00+00'),
  ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000f1', 'charge', 7000, 'card', 'failed', 'portal', true, '2026-06-02 15:00+00'),
  ('00000000-0000-0000-0000-00000000aa06', '00000000-0000-0000-0000-0000000000fd', 'charge', 45000, 'card', 'succeeded', 'portal', true, '2026-06-03 15:00+00'),
  ('00000000-0000-0000-0000-00000000aa07', '00000000-0000-0000-0000-0000000000f1', 'charge', 10000, 'card', 'succeeded', 'portal', true, '2026-01-01 00:30+00'),
  ('00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-0000000000f1', 'charge', 20000, 'card', 'succeeded', 'portal', true, '2025-06-01 15:00+00');
insert into public.dues_payments (id, family_id, direction, amount_cents, method, status, source, livemode, occurred_at, refunds_payment_id) values
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f1', 'refund', 5000, 'card', 'succeeded', 'portal', true, '2026-05-01 15:00+00', '00000000-0000-0000-0000-00000000aa01');

-- Other income (one voided) and expenses (one voided).
insert into public.tax_other_income (received_on, amount_cents, kind, description) values
  ('2026-02-02', 50000, 'donation', 'Family gift'), ('2026-09-09', 100000, 'grant', 'County grant'), ('2024-05-05', 8000, 'fundraiser', 'Bake sale');
insert into public.tax_other_income (received_on, amount_cents, kind, description, voided_at, void_reason) values
  ('2026-10-10', 3000, 'fundraiser', 'Entered twice', now(), 'Duplicate');
insert into public.expenses (spent_on, amount_cents, category_id, vendor) values
  ('2026-03-03', 120000, (select id from public.expense_categories where name = 'Teacher stipends'), 'Jane Doe'),
  ('2026-08-08', 90000, (select id from public.expense_categories where name = 'Teacher stipends'), ' jane doe '),
  ('2026-04-04', 150000, (select id from public.expense_categories where name = 'Professional services'), 'Bob Smith'),
  ('2026-05-05', 80000, (select id from public.expense_categories where name = 'Insurance'), 'Church Mutual'),
  ('2025-07-07', 70000, (select id from public.expense_categories where name = 'Professional services'), 'Bob Smith');
insert into public.expenses (spent_on, amount_cents, category_id, vendor, voided_at, void_reason) values
  ('2026-06-06', 5000, (select id from public.expense_categories where name = 'Other'), 'Mistake', now(), 'Wrong');
update public.org_facts set value = '12-3456789' where key = 'ein';
update public.org_facts set value = 'Veritas Village Test Co-op' where key = 'legal_name';

-- ---- who may call what -----------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_tax_summary(integer)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_add_other_income(date,bigint,text,text,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_set_tax_year_inputs(integer,bigint,bigint,text)', 'EXECUTE'), 'visitors cannot call the tax functions');
select ok(not has_function_privilege('authenticated', 'private.portal_gross_receipts(date,date)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.tax_year_bounds(integer)', 'EXECUTE'), 'the private helpers are not callable');
select ok(not has_table_privilege('authenticated', 'public.tax_other_income', 'INSERT')
          and not has_table_privilege('authenticated', 'public.tax_other_income', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.tax_year_inputs', 'INSERT'), 'nobody writes the tax tables directly');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.admin_tax_summary(integer)'::regprocedure),
          'the summary is security definer with an empty search path');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_tax_summary(2026)$$, '42501', 'Administrator access is required.', 'a parent cannot see the summary');
select is((select count(*)::int from public.tax_other_income), 0, 'or the other income');
select throws_ok($$select public.admin_add_other_income('2026-01-01', 100, 'donation', 'X', null)$$, '42501', 'Administrator access is required.', 'or add to it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_tax_summary(2026)$$, '42501', 'Administrator access is required.', 'a reviewer account with the admin role is refused');
select is((select count(*)::int from public.tax_year_inputs), 0, 'and sees no inputs');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_tax_summary(2026)$$, '42501', 'Complete two-factor verification before continuing.', 'an administrator must pass the second factor');
reset role;

-- ---- the numbers ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table s26 as select public.admin_tax_summary(2026) as j;
select is((select j ->> 'first_day' from s26), '2026-01-01', 'a calendar-year co-op''s 2026 starts on 1 January');
select is((select j ->> 'last_day' from s26), '2026-12-31', 'and ends on 31 December');
select is((select (j ->> 'dues_online_cents')::int from s26), 30000, 'online dues: real, succeeded, the co-op''s own families only');
select is((select (j ->> 'dues_offline_cents')::int from s26), 15000, 'offline dues (cash, check, Crowded)');
select is((select (j ->> 'refunds_cents')::int from s26), 5000, 'refunds, separately');
select is((select (j ->> 'other_income_cents')::int from s26), 150000, 'other income, without the voided entry');
select is((select jsonb_array_length(j -> 'other_income') from s26), 2, 'listed one by one');
select is((select (j ->> 'gross_receipts_cents')::int from s26), 195000, 'gross receipts = dues + other income, before refunds');
select is((select (j ->> 'expenses_cents')::int from s26), 440000, 'expenses, without the voided one');
select is((select (j ->> 'net_cents')::int from s26), -250000, 'net = gross receipts - refunds - expenses');
select is((select (j -> 'expenses' -> 0 ->> 'category') from s26), 'Teacher stipends', 'expenses by category, largest first');
select is((select (j -> 'expenses' -> 0 ->> 'cents')::int from s26), 210000, 'with the category total');
select is((select (j ->> 'billing_test_mode')::boolean from s26), false, 'billing is not in test mode');

-- 3-year gross receipts
select is((select jsonb_array_length(j -> 'years') from s26), 3, 'three years for the average');
select is((select (j -> 'years' -> 0 ->> 'year')::int from s26), 2026, 'this year first');
select is((select (j -> 'years' -> 1 ->> 'used_cents')::int from s26), 30000, '2025 from the portal (including the 31 December payment made at 00:30 UTC)');
select is((select (j -> 'years' -> 2 ->> 'used_cents')::int from s26), 8000, '2024 from the portal');
select lives_ok($$select public.admin_set_tax_year_inputs(2024, null, 40000, 'From the 2024 bank statements')$$, 'an administrator enters a year from before the portal');
select is((select (public.admin_tax_summary(2026) -> 'years' -> 2 ->> 'used_cents')::int), 40000, 'and the entered figure is used instead');
select is((select (public.admin_tax_summary(2026) -> 'years' -> 2 ->> 'portal_cents')::int), 8000, 'with the portal''s figure still shown');
select lives_ok($$select public.admin_set_tax_year_inputs(2026, 1234500, null, null)$$, 'and the total assets at the end of 2026');
select is((select (public.admin_tax_summary(2026) ->> 'total_assets_cents')::int), 1234500, 'which the summary returns');

-- payees for the 1099-NEC
select is((select jsonb_array_length(j -> 'payees') from s26), 1, '2026: one payee reached the $2,000 threshold');
select is((select j -> 'payees' -> 0 ->> 'payee' from s26), 'Jane Doe', 'names written two ways count as one payee');
select is((select (j -> 'payees' -> 0 ->> 'cents')::int from s26), 210000, 'with the year''s total');
select is((select (j ->> 'nec_threshold_cents')::int from s26), 200000, 'the 2026 threshold is $2,000');
select is((select (public.admin_tax_summary(2025) ->> 'nec_threshold_cents')::int), 60000, 'the 2025 threshold is $600');
select is((select public.admin_tax_summary(2025) -> 'payees' -> 0 ->> 'payee'), 'Bob Smith', 'so $700 to one payee in 2025 is listed');
select is((select (public.admin_tax_summary(2027) ->> 'nec_threshold_certain')::boolean), false, 'after 2026 the threshold is flagged to check (inflation adjustment)');

-- key facts
select is((select j -> 'facts' -> 'ein' ->> 'value' from s26), '••••6789', 'the EIN is masked');
select is((select (j -> 'facts' -> 'ein' ->> 'has_value')::boolean from s26), true, 'but known to be there');
select is((select j -> 'facts' -> 'legal_name' ->> 'value' from s26), 'Veritas Village Test Co-op', 'the legal name is shown');
select is((select (j -> 'facts' -> 'principal_officer_name' ->> 'has_value')::boolean from s26), false, 'a missing principal officer is flagged');
select is((select count(*)::int from jsonb_object_keys((select j -> 'facts' from s26))), 7, 'all seven checklist facts come back');

-- other income
select throws_ok($$select public.admin_add_other_income('2026-01-01', 0, 'donation', 'X', null)$$, 'P0001', 'Enter the amount.', 'other income needs an amount');
select throws_ok($$select public.admin_add_other_income('2026-01-01', 100, 'raffle', 'X', null)$$, 'P0001', 'Choose what kind of income it is.', 'and a known kind');
select throws_ok($$select public.admin_add_other_income(current_date + 5, 100, 'donation', 'X', null)$$, 'P0001', 'The date cannot be in the future.', 'and a date that is not in the future');
select lives_ok($$select public.admin_add_other_income('2026-11-01', 2500, 'fundraiser', 'Fall plant sale', null)$$, 'an administrator adds a fundraiser');
select is((select (public.admin_tax_summary(2026) ->> 'gross_receipts_cents')::int), 197500, 'and gross receipts go up by it');
select lives_ok(format($$select public.admin_void_other_income(%L, 'Entered in error')$$, (select id from public.tax_other_income where description = 'Fall plant sale')), 'and voids it');
select is((select (public.admin_tax_summary(2026) ->> 'gross_receipts_cents')::int), 195000, 'which takes it back out');
select ok(exists (select 1 from public.audit_log where action = 'other_income_voided'), 'both are in the audit log');
reset role;

-- ---- test mode and the fiscal year ---------------------------------------------------------------------
update public.billing_settings set provider = 'stripe_test' where id = 'dues';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select (public.admin_tax_summary(2026) ->> 'dues_online_cents')::int), 129999, 'while billing is in test mode, test payments count (as everywhere else in billing)');
select is((select (public.admin_tax_summary(2026) ->> 'billing_test_mode')::boolean), true, 'and the summary says so');
reset role;
update public.billing_settings set provider = 'off' where id = 'dues';
update public.compliance_settings set fiscal_year_end_month = 6;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select public.admin_tax_summary(2026) ->> 'first_day'), '2025-07-01', 'a 30 June year end: the 2026 year starts 1 July 2025');
select is((select (public.admin_tax_summary(2026) ->> 'dues_online_cents')::int), 40000, 'and takes the payments in it');
reset role;

select * from finish();
rollback;
