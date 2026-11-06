-- Dues payments: who can see and change money, the append-only ledger, balances
-- derived from the ledger, payment plans, approvals, and keeping a household's
-- billing records when its members leave.
begin;
select plan(109);

-- A1 and A2 administrators; P1 and P1b adults of household F1 (two active
-- children), P2 adult of F2 (one child), D a reviewer (demo) parent.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'demo@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'), ('00000000-0000-0000-0000-0000000000f3', 'Demo');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent');
insert into public.children (family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'K1'), ('00000000-0000-0000-0000-0000000000f1', 'K1b'),
  ('00000000-0000-0000-0000-0000000000f2', 'K2'), ('00000000-0000-0000-0000-0000000000f3', 'KD');
insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000e0', '2026-27', true);
insert into public.requirements (id, school_year_id, kind, title, amount_per_family, amount_per_child, due_on)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e0', 'dues', 'Dues 2026-27', 300, 150, date '2026-09-01');

-- ---- who can call what -------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.billing_apply_payment_update(uuid,text,text,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.billing_apply_payment_update(uuid,text,text,jsonb)', 'EXECUTE'), 'signed-in users cannot apply a payment update');
select ok(has_function_privilege('service_role', 'public.billing_apply_payment_update(uuid,text,text,jsonb)', 'EXECUTE'), 'the service role can');
select ok(not has_function_privilege('authenticated', 'public.stripe_claim_event(text,text,boolean,jsonb)', 'EXECUTE'), 'nor claim webhook events');
select ok(not has_function_privilege('anon', 'public.admin_open_dues(uuid,uuid[])', 'EXECUTE'), 'visitors cannot open dues');

-- ---- opening dues -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_open_dues('00000000-0000-0000-0000-0000000000d1')$$, '42501', 'Administrator access is required.', 'a parent cannot open dues');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_open_dues('00000000-0000-0000-0000-0000000000d1'), 2, 'dues open for the two real households and skip the reviewer household');
select is(public.admin_open_dues('00000000-0000-0000-0000-0000000000d1'), 0, 'opening again creates nothing');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 60000, 'one family fee plus two children is $600');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 45000, 'one child is $450');
select throws_ok($$update public.dues_charges set amount_paid_cents = 60000$$, '42501', null, 'an administrator cannot type a paid total into the table');
select throws_ok($$insert into public.dues_payments (family_id, direction, amount_cents, status, source, livemode) values ('00000000-0000-0000-0000-0000000000f1', 'charge', 100, 'succeeded', 'admin_manual', true)$$, '42501', null, 'nor insert into the ledger directly');
reset role;
select is((select amount_due from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'), 600.00::numeric, 'the compliance row mirrors the amount');

-- ---- reading ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.dues_charges), 1, 'a family sees only its own charge');
select is((select count(*)::int from public.dues_ledger), 1, 'and only its own ledger line');
select is((select count(*)::int from public.billing_approvals), 0, 'a family never sees approvals');
select throws_ok($$select count(*) from public.stripe_webhook_events$$, '42501', null, 'nor Stripe events');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.dues_charges), 0, 'the reviewer account sees no real household money');
reset role;

-- ---- adjustments and discounts ------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table adj as select public.admin_add_adjustment((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 2000, 'late_fee', 'Late fee') as id;
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 62000, 'a late fee raises what is owed');
select lives_ok($$select public.admin_reverse_adjustment((select id from adj), 'Waived the late fee')$$, 'it is undone with a reversing entry');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 60000, 'back to $600');
select throws_ok($$select public.admin_reverse_adjustment((select id from adj), 'again')$$, 'P0001', 'That adjustment was already reversed.', 'an adjustment is reversed once');
reset role;
select throws_ok($$update public.dues_adjustments set memo = 'edited'$$, '23000', null, 'adjustments are never edited');
select throws_ok($$delete from public.dues_adjustments$$, '23000', null, 'or deleted');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table dt as select public.admin_create_discount_type('board', 'Board member', 'percent', 1000) as id;
select lives_ok($$select public.admin_apply_discount((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), (select id from dt), null, null)$$, 'a percent discount applies');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 40500, '10% off $450');
select throws_ok($$select public.admin_apply_discount((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), null, 'Too much', 999999)$$, 'P0001', 'Discounts cannot exceed the base amount.', 'a discount cannot exceed the base');
reset role;

-- ---- paying -----------------------------------------------------------------------------------------
select throws_ok($$select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'))$$, 'P0001', 'online_payments_off', 'nothing can be paid while payments are off');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_billing_provider('stripe_test')$$, 'test mode needs no approval');
select throws_ok($$select public.admin_set_billing_provider('stripe_live')$$, '42501', null, 'live mode needs an approval');
reset role;

select set_config('request.jwt.claims', '{}', true);
set local role service_role;
create temp table pay1 as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1')) as r;
select is((select (r ->> 'amount_cents')::int from pay1), 60000, 'the server decides the amount: the whole balance');
select is((select (public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'))) ->> 'existing'), 'true', 'a second click reuses the attempt in flight');
select throws_ok($$select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b2', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'))$$, 'P0001', 'not_allowed', 'another household cannot pay it');
select throws_ok($$select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b3', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'))$$, 'P0001', 'not_allowed', 'a reviewer account cannot pay a real household');
select is((select count(*)::int from public.dues_payments where status = 'pending'), 1, 'only one attempt is open');

select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay1), 'processing', 'evt_1', '{"method":"us_bank_account","bank_name":"Test Bank","last4":"6789"}'), 'applied', 'ACH goes to processing');
select is((select amount_paid_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 0, 'processing money is not yet paid');
select is((public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), true) ->> 'existing'), 'true', 'still no second attempt while the transfer is in flight');

-- the bank settles
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay1), 'succeeded', 'evt_2',
  '{"method":"us_bank_account","bank_name":"Test Bank","last4":"6789","payment_intent_id":"pi_1","charge_id":"ch_1","receipt_url":"https://pay.stripe.com/receipts/x","occurred_at":"2026-09-02T15:00:00Z"}'), 'applied', 'the settled event applies');
reset role;
select is((select amount_paid_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 60000, 'the paid total comes from the ledger');
select is((select status from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 'paid', 'the charge is paid');
select is((select status from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'), 'complete', 'and the compliance item is complete');
select ok((select receipt_no is not null from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from pay1)), 'a receipt number is issued');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'payment_received'), 1, 'the family is told');

set local role service_role;
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay1), 'succeeded', 'evt_2', '{}'), 'applied', 'the same event twice is harmless');
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay1), 'processing', 'evt_0', '{}'), 'ignored', 'a late "processing" cannot undo "succeeded"');
reset role;
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'payment_received'), 1, 'and nobody is told twice');
select is((select amount_paid_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 60000, 'nor is it counted twice');

-- ---- the ledger cannot be rewritten -------------------------------------------------------------------
select throws_ok($$update public.dues_payments set amount_cents = 1$$, '23000', null, 'a payment amount cannot change');
select throws_ok($$delete from public.dues_payments$$, '23000', null, 'a payment is never deleted');
select throws_ok($$update public.dues_payments set status = 'pending'$$, '23000', null, 'status never moves backwards');

-- ---- a late ACH return --------------------------------------------------------------------------------------------
set local role service_role;
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay1), 'failed', 'evt_3', '{"failure_code":"R01","failure_message":"Insufficient funds"}'), 'applied', 'a returned transfer is applied');
reset role;
select is((select amount_paid_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 0, 'the money is no longer counted');
select is((select status from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 'open', 'the charge reopens');
select isnt((select status from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'), 'complete', 'and so does the compliance item');
select is((select count(*)::int from public.notifications where kind = 'payment_failed' and recipient_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'administrators are told');
select throws_ok($$update public.dues_payments set status = 'succeeded'$$, '23000', null, 'a failed payment is never resurrected; the family pays again');

-- pays again by card, then part is refunded
set local role service_role;
create temp table pay2 as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1')) as r;
select is((select r ->> 'existing' from pay2), 'false', 'a new attempt opens once the old one has failed');
select public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay2), 'succeeded', 'evt_4',
  '{"method":"card","wallet":"apple_pay","brand":"visa","last4":"4242","payment_intent_id":"pi_2","charge_id":"ch_2"}');
reset role;
select is((select wallet from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from pay2)), 'apple_pay', 'the wallet used is kept for display');
select is((select status from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 'paid', 'paid again');

set local role service_role;
select throws_ok($$select public.billing_begin_refund('00000000-0000-0000-0000-0000000000b1', (select (r ->> 'payment_id')::uuid from pay2), 1000, 'x', true)$$, '42501', 'Administrator access is required.', 'a parent cannot start a refund');
select throws_ok($$select public.billing_begin_refund('00000000-0000-0000-0000-0000000000a1', (select (r ->> 'payment_id')::uuid from pay2), 70000, 'too much', true)$$, 'P0001', null, 'a refund cannot exceed the payment');
create temp table ref1 as select public.billing_begin_refund('00000000-0000-0000-0000-0000000000a1', (select (r ->> 'payment_id')::uuid from pay2), 10000, 'Withdrew a child', true) as r;
select public.billing_attach_refund((select (r ->> 'refund_id')::uuid from ref1), 're_1', 'succeeded');
reset role;
select is((select amount_refunded_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 10000, 'the refund is counted once Stripe confirms');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 50000, 'and what the family owes drops by the same amount');
select is((select status from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 'paid', 'so the charge stays paid');
set local role service_role;
select is(public.billing_apply_refund('re_2', 'pi_2', null, 5000, 'succeeded', 'evt_9'), 'applied', 'a refund made in the Stripe dashboard is recorded');
select is(public.billing_apply_refund('re_2', 'pi_2', null, 5000, 'succeeded', 'evt_9'), 'ignored', 'once');
reset role;
select is((select amount_refunded_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 15000, 'and counted');

-- ---- payment plans ----------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.admin_set_dues_options('00000000-0000-0000-0000-0000000000d1', true, 3, date '2026-09-01');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.family_choose_plan((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 'monthly')$$, 'a family chooses the monthly plan');
select is((select count(*)::int from public.dues_installments), 3, 'three installments');
select is((select min(amount_cents) from public.dues_installments), 13500, 'of $135 each');
reset role;

set local role service_role;
select public.billing_set_customer('00000000-0000-0000-0000-0000000000f2', false, 'cus_test_2');
create temp table pay3 as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b2', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), false, true) as r;
select is((select (r ->> 'amount_cents')::int from pay3), 13500, 'paying now pays the first installment, not the year');
select public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay3), 'succeeded', 'evt_5',
  '{"method":"card","brand":"visa","last4":"4242","payment_method_id":"pm_1","payment_intent_id":"pi_3"}');
reset role;
select is((select status from public.dues_installments where seq = 1), 'paid', 'the first installment is paid');
select is((select status from public.dues_payment_plans where charge_id = (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2')), 'active', 'the plan stays active');
select ok((select autopay from public.billing_customers where family_id = '00000000-0000-0000-0000-0000000000f2'), 'the saved method is used for automatic payments, because the family agreed at checkout');

set local role service_role;
select is((select (public.billing_begin_payment('00000000-0000-0000-0000-0000000000b2', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), true) ->> 'amount_cents')::int), 27000, 'a family can pay off the rest early');
select public.billing_cancel_payment((select (public.billing_begin_payment('00000000-0000-0000-0000-0000000000b2', (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), true) ->> 'payment_id')::uuid), 'changed their mind');
select is((select count(*)::int from public.billing_due_autopay(date '2027-12-31')), 1, 'once its date has passed the next unpaid installment is due for automatic collection');
create temp table auto1 as select public.billing_begin_autopay((select id from public.dues_installments where seq = 2), date '2027-12-31') as r;
select is((select (r ->> 'amount_cents')::int from auto1), 13500, 'the automatic charge is one installment');
select throws_ok($$select public.billing_begin_autopay((select id from public.dues_installments where seq = 3), date '2027-12-31')$$, 'P0001', 'installment_not_due', 'a later installment is never collected ahead of an earlier one');
select public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from auto1), 'failed', 'evt_6', '{"failure_message":"Card declined"}');
select is((select count(*)::int from public.billing_due_autopay(date '2027-12-31')), 0, 'after a failure it waits before trying again');
reset role;
select is((select attempts from public.dues_installments where seq = 2), 1, 'the attempt is counted');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_plan((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), '[{"due_on":"2026-10-01","amount_cents":1000}]')$$, 'P0001', null, 'a custom plan must add up to what is owed');
select lives_ok($$select public.admin_set_plan((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), '[{"due_on":"2026-10-01","amount_cents":10000},{"due_on":"2027-01-15","amount_cents":17000}]')$$, 'an administrator sets a deposit and the rest');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.family_choose_plan((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 'full')$$, 'P0001', null, 'a family cannot undo a custom plan');
reset role;

-- reminders
update public.dues_installments set due_on = current_date + 3 where status = 'scheduled' and seq = 1 and plan_id = (select id from public.dues_payment_plans where kind = 'custom');
set local role service_role;
select is(public.billing_queue_reminders(), 1, 'an installment due in three days gets one reminder');
select is(public.billing_queue_reminders(), 0, 'and only one');
reset role;

-- ---- recording cash and refunding it --------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table cash1 as select public.admin_record_offline_payment((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 1000, 'cash', 'receipt book 12', date '2026-09-10') as id;
select throws_ok($$select public.admin_record_offline_payment((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 99999999, 'cash', null, null)$$, 'P0001', null, 'cash cannot exceed what is owed');
select lives_ok($$select public.admin_record_offline_refund((select id from cash1), 500, 'Gave change back', false)$$, 'cash is refunded by recording it');
select throws_ok($$select public.admin_record_offline_refund((select id from cash1), 600, 'too much', false)$$, 'P0001', null, 'but not more than was paid');
reset role;

-- ---- live billing needs a second person ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table appr as select public.admin_request_approval('enable_livemode', null, null, 0, 'Go live for 2026-27') as id;
select throws_ok($$select public.admin_decide_approval((select id from appr), true)$$, 'P0001', null, 'you cannot approve your own request');
select throws_ok($$select public.admin_set_billing_provider('stripe_live', (select id from appr))$$, '42501', null, 'a pending request does not enable live mode');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_decide_approval((select id from appr), true, 'Checked')$$, 'a different administrator approves');
select throws_ok($$select public.admin_set_billing_provider('stripe_live', (select id from appr))$$, '42501', null, 'the approver cannot also be the one who flips the switch');
reset role;
select throws_ok($$update public.billing_approvals set approved_by = requested_by$$, '23514', null, 'the database refuses an approval by the requester');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_billing_provider('stripe_live', (select id from appr))$$, 'with a valid approval, live mode turns on');
select throws_ok($$select public.admin_set_billing_provider('stripe_live', (select id from appr))$$, '42501', null, 'an approval works once');
reset role;
select is((select amount_paid_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1'), 0, 'test-mode payments do not count once live');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_billing_provider('stripe_test')$$, 'going back to test is always allowed');
select lives_ok($$select public.admin_purge_test_billing_data()$$, 'test data can be cleared before going live');
reset role;
select is((select count(*)::int from public.dues_payments where not livemode), 0, 'and only test data');

-- ---- Stripe events are received once ---------------------------------------------------------------------------------------------------
set local role service_role;
select is(public.stripe_claim_event('evt_x', 'payment_intent.succeeded', false, '{"a":1}'), 'new', 'a new event');
select is(public.stripe_claim_event('evt_x', 'payment_intent.succeeded', false, '{"a":1}'), 'retry', 'delivered again before it finished');
select public.stripe_finish_event('evt_x');
select is(public.stripe_claim_event('evt_x', 'payment_intent.succeeded', false, '{"a":1}'), 'processed', 'then recognised as done');
reset role;
update public.stripe_webhook_events set received_at = now() - interval '100 days' where id = 'evt_x';
select is(public.billing_prune_webhook_events(), 1, 'old payloads are cleared');

-- ---- keeping billing records when a household goes away ------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select throws_ok($$delete from public.families where id = '00000000-0000-0000-0000-0000000000f2'$$, '23503', null, 'an administrator cannot delete a household that has payment records');
select set_config('request.jwt.claims', '{}', true);
delete from public.families where id = '00000000-0000-0000-0000-0000000000f2';
select is((select display_name from public.families where id = '00000000-0000-0000-0000-0000000000f2'), 'Former household', 'a member erasing their account leaves the household, renamed');
select is((select count(*)::int from public.children where family_id = '00000000-0000-0000-0000-0000000000f2'), 0, 'its children are removed');
select is((select count(*)::int from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 1, 'and the charge is kept');

insert into public.dues_charges (requirement_id, family_id, school_year_id, subtotal_cents)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e0', 1000);
insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode)
select id, family_id, 'charge', 500, 'card', 'succeeded', 'portal', false from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f3';
delete from public.families where id = '00000000-0000-0000-0000-0000000000f3';
select is((select count(*)::int from public.families where id = '00000000-0000-0000-0000-0000000000f3'), 0, 'a reviewer household and its sample money are removed with the sample world');
select is((select count(*)::int from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f3'), 0, 'including the sample charge');

select * from finish();
rollback;
