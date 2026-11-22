-- Dues ledger fixes (#170, #185, #208): cash and checks are real money in any
-- mode and survive the test-data purge; a refund webhook that arrives early
-- matches the admin's refund instead of doubling it; refunds for other charges
-- are not ours; a reminder is sent once even when daily runs overlap.
begin;
select plan(30);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent');
insert into public.admin_tiers (user_id, tier) values ('00000000-0000-0000-0000-0000000000a1', 'board') on conflict do nothing;
insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent');
insert into public.children (family_id, first_name) values ('00000000-0000-0000-0000-0000000000f1', 'K1'), ('00000000-0000-0000-0000-0000000000f2', 'K2');
insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000e0', '2026-27', true);
insert into public.requirements (id, school_year_id, kind, title, amount_per_family, amount_per_child, due_on)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e0', 'dues', 'Dues 2026-27', 300, 150, date '2026-09-01');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.admin_set_billing_provider('stripe_test');
select public.admin_open_dues('00000000-0000-0000-0000-0000000000d1');
select public.admin_set_dues_options('00000000-0000-0000-0000-0000000000d1', true, 3, current_date);
reset role;
create temp table ch as select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f1';
grant select on ch to public;

-- ---- #170: cash recorded while rehearsing in test mode is real money --------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table cash as select public.admin_record_offline_payment((select id from ch), 10000, 'cash', 'receipt book 12', null) as id;
reset role;
select ok((select livemode from public.dues_payments where id = (select id from cash)), 'cash recorded in test mode is marked as real money');

-- A Stripe test payment for the rest.
set local role service_role;
create temp table pay as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), true) as r;
select public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from pay), 'succeeded', 'evt_1',
  '{"method":"card","brand":"visa","last4":"4242","payment_intent_id":"pi_t","charge_id":"ch_t"}');
reset role;
select ok(not (select livemode from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from pay)), 'the Stripe test payment is test data');
select is((select status from public.dues_charges where id = (select id from ch)), 'paid', 'together they pay the year');

-- ---- #185: a refund webhook that beats billing_attach_refund ------------------------------------------------
set local role service_role;
create temp table ref1 as select public.billing_begin_refund('00000000-0000-0000-0000-0000000000a1', (select (r ->> 'payment_id')::uuid from pay), 2000, 'Withdrew a class') as r;
select is(public.billing_apply_refund('re_early', 'pi_t', 'ch_t', 2000, 'succeeded', 'evt_r1', null, (select (r ->> 'refund_id')::uuid from ref1)),
  'applied', 'the early webhook is applied');
reset role;
select is((select count(*)::int from public.dues_payments where direction = 'refund'), 1, 'to the admin''s own refund row, not a second one');
select is((select stripe_refund_id from public.dues_payments where id = (select (r ->> 'refund_id')::uuid from ref1)), 're_early', 'which now carries Stripe''s refund id');
select is((select status from public.dues_payments where id = (select (r ->> 'refund_id')::uuid from ref1)), 'succeeded', 'and Stripe''s status');
select is((select count(*)::int from public.notifications where kind = 'refund_recorded'), 0, 'administrators are not told it was refunded outside the portal');

set local role service_role;
select lives_ok($$select public.billing_attach_refund((select (r ->> 'refund_id')::uuid from ref1), 're_early', 'succeeded', true)$$,
  'attaching afterwards does not hit the unique refund id');
select lives_ok($$select public.billing_attach_refund((select (r ->> 'refund_id')::uuid from ref1), 're_early', 'succeeded', true)$$, 'nor does attaching twice');
reset role;
select is((select count(*)::int from public.dues_adjustments where reason = 'refund_credit'), 1, 'the "reduce what is owed" credit is written, once');
select is((select amount_due_cents from public.dues_charges where id = (select id from ch)), 43000, 'so the family owes $20 less');
select is((select amount_refunded_cents from public.dues_charges where id = (select id from ch)), 2000, 'and the refund counts once');

-- No metadata (an older refund): the one pending refund for that payment and amount is matched.
set local role service_role;
create temp table ref2 as select public.billing_begin_refund('00000000-0000-0000-0000-0000000000a1', (select (r ->> 'payment_id')::uuid from pay), 1500, 'Overpaid') as r;
select is(public.billing_apply_refund('re_nometa', 'pi_t', null, 1500, 'pending', 'evt_r2'), 'applied', 'a refund without our id is matched by payment and amount');
reset role;
select is((select stripe_refund_id from public.dues_payments where id = (select (r ->> 'refund_id')::uuid from ref2)), 're_nometa', 'to the pending refund');
select is((select status from public.dues_payments where id = (select (r ->> 'refund_id')::uuid from ref2)), 'processing', 'which is now in progress');
select is((select count(*)::int from public.dues_payments where direction = 'refund'), 2, 'still no duplicate');
select is((select count(*)::int from public.dues_payments where refunds_payment_id = (select (r ->> 'payment_id')::uuid from pay) and status in ('pending', 'processing', 'succeeded')), 2,
  'so the refundable remainder is not capped by a phantom row');

-- A refund made in the Stripe dashboard is still recorded; one for someone else's charge is not ours.
set local role service_role;
select is(public.billing_apply_refund('re_dash', 'pi_t', null, 500, 'succeeded', 'evt_r3'), 'applied', 'a dashboard refund is recorded');
select is(public.billing_apply_refund('re_other', 'pi_donation', 'ch_donation', 2500, 'succeeded', 'evt_r4'), 'not_ours',
  'a refund on a charge that is not a dues payment is acknowledged, not an error');
reset role;
select is((select source from public.dues_payments where stripe_refund_id = 're_dash'), 'stripe_dashboard', 'the dashboard refund is its own row');
select is((select count(*)::int from public.notifications where kind = 'refund_recorded'), 1, 'and administrators are told about it');

-- ---- #170: the purge keeps money recorded by hand ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table cashref as select public.admin_record_offline_refund((select id from cash), 500, 'Gave change back', false) as id;
reset role;
select ok((select livemode from public.dues_payments where id = (select id from cashref)), 'a refund of cash is real money too');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_purge_test_billing_data()$$, 'test data is cleared');
reset role;
select is((select count(*)::int from public.dues_payments where id in ((select id from cash), (select id from cashref))), 2, 'the cash payment and its refund are kept');
select is((select count(*)::int from public.dues_payments where not livemode), 0, 'every Stripe test row is gone');
select is((select amount_paid_cents from public.dues_charges where id = (select id from ch)), 10000, 'the household is still credited for the cash');

-- ---- #208: a reminder is sent once even if two daily runs overlap --------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select public.family_choose_plan((select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2'), 'monthly');
reset role;
update public.dues_installments set due_on = current_date + 3
where seq = 1 and charge_id = (select id from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f2');
-- Stand in for the other run: its log row already exists, so this run's insert writes nothing.
create function pg_temp.other_run_claimed() returns trigger language plpgsql as $$ begin return null; end; $$;
create trigger other_run before insert on public.dues_reminder_log for each row execute function pg_temp.other_run_claimed();
set local role service_role;
select is(public.billing_queue_reminders(), 0, 'when another run already logged the reminder, this run sends nothing');
reset role;
drop trigger other_run on public.dues_reminder_log;
select is((select count(*)::int from public.notifications where kind = 'installment_reminder'), 0, 'and no second notification goes out');
set local role service_role;
select is(public.billing_queue_reminders(), 1, 'on its own, the run sends the reminder once');
reset role;

select * from finish();
rollback;
