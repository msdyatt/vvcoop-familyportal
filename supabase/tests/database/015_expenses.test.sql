-- Expenses: administrators only, edits keep history, nothing is deleted, receipts
-- cannot be changed, and the finance summary nets dues collected against spending.
begin;
select plan(18);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent');

select ok(not has_function_privilege('anon', 'public.admin_create_expense(date,integer,uuid,text,text)', 'EXECUTE'), 'visitors cannot record an expense');

-- a parent
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_create_expense(current_date, 1000, (select id from public.expense_categories limit 1), 'Staples', null)$$, '42501', 'Administrator access is required.', 'a parent cannot record an expense');
select is((select count(*)::int from public.expenses), 0, 'and sees none');
select is((select count(*)::int from public.expense_categories), 0, 'nor the categories');
reset role;

-- the administrator
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table ex as select public.admin_create_expense(date '2026-09-10', 12550, (select id from public.expense_categories where name = 'Curriculum and supplies'), 'Staples', 'Markers') as id;
select is((select count(*)::int from public.expense_revisions where expense_id = (select id from ex)), 1, 'recording an expense writes its first revision');
select throws_ok($$select public.admin_create_expense(date '2026-09-10', 0, (select id from public.expense_categories limit 1), 'X', null)$$, '23514', null, 'an amount must be above zero');
select throws_ok($$select public.admin_update_expense((select id from ex), date '2026-09-10', 13000, (select id from public.expense_categories limit 1), 'Staples', 'Markers', '')$$, 'P0001', 'Say why you are changing it.', 'an edit needs a reason');
select is(public.admin_update_expense((select id from ex), date '2026-09-10', 13000, (select id from public.expense_categories where name = 'Curriculum and supplies'), 'Staples', 'Markers and paper', 'Receipt total was higher'), 2, 'an edit makes version 2');
select is((select amount_cents from public.expense_revisions where expense_id = (select id from ex) and version = 1), 12550, 'and the original amount is still on record');
do $$ begin update public.expenses set amount_cents = 1; exception when insufficient_privilege then null; end $$;
select is((select amount_cents from public.expenses where id = (select id from ex)), 13000, 'the table cannot be written to directly');
reset role;
select throws_ok($$update public.expense_revisions set vendor = 'x'$$, '23000', null, 'history is never edited');
select throws_ok($$delete from public.expenses$$, '23503', null, 'an expense is never deleted');

-- receipts
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table rc as select public.admin_add_expense_receipt((select id from ex), 'expenses/' || (select id from ex)::text || '/r1.pdf', 'receipt.pdf', 'application/pdf', 1000) as id;
select throws_ok($$select public.admin_add_expense_receipt((select id from ex), 'expenses/other/r2.pdf', 'x.pdf', 'application/pdf', 10)$$, '23514', null, 'a receipt must live under its own expense');
select lives_ok($$select public.admin_remove_expense_receipt((select id from rc), 'Uploaded the wrong page')$$, 'a receipt can be removed with a reason');
reset role;
select ok((select removed_at is not null and storage_path is not null from public.expense_receipts where id = (select id from rc)), 'but the record and file path stay');
select throws_ok($$delete from public.expense_receipts$$, '23000', null, 'a receipt row is never deleted');

-- voiding and the summary
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.admin_create_expense(date '2026-09-11', 5000, (select id from public.expense_categories where name = 'Insurance'), 'Insurer', null);
select is((public.admin_finance_summary(date '2026-09-01', date '2026-09-30') ->> 'expenses_cents')::int, 18000, 'the summary adds up spending in the range');
select public.admin_void_expense((select id from ex), 'Entered twice');
select is((public.admin_finance_summary(date '2026-09-01', date '2026-09-30') ->> 'expenses_cents')::int, 5000, 'a voided expense drops out of the total but stays in the record');
reset role;

select * from finish();
rollback;
