-- Dues checkout fixes (#169, #186): an attempt for another amount is reported so
-- it can be replaced, and a payment the portal had canceled that Stripe then
-- collects is credited and flagged to administrators instead of dropped.
begin;
select plan(22);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent');
insert into public.admin_tiers (user_id, tier) values ('00000000-0000-0000-0000-0000000000a1', 'board') on conflict do nothing;
insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'One');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent');
insert into public.children (family_id, first_name) values ('00000000-0000-0000-0000-0000000000f1', 'K1');
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

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.family_choose_plan((select id from ch), 'monthly')$$, 'the family chooses three monthly payments of $150');
reset role;

-- ---- #186: an attempt for another amount is reported ----------------------------------------------
set local role service_role;
create temp table inst as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), false) as r;
select is((select (r ->> 'amount_cents')::int from inst), 15000, 'paying now starts the first installment');
create temp table whole as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), true) as r;
select is((select r ->> 'existing' from whole), 'true', 'asking to pay it all finds the installment attempt in flight');
select is((select r ->> 'amount_mismatch' from whole), 'true', 'and says it is for another amount, so it can be closed and replaced');
select is((select (r ->> 'wanted_amount_cents')::int from whole), 45000, 'with the amount this request would charge');
select is((select (public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), false)) ->> 'amount_mismatch'), 'false',
  'asking for the installment again resumes the same attempt');
select is((select count(*)::int from public.dues_payments where status = 'pending'), 1, 'still only one attempt is open');

-- ---- #169: canceled in the portal, then paid at Stripe ---------------------------------------------
select public.billing_cancel_payment((select (r ->> 'payment_id')::uuid from inst), 'Canceled by an administrator.');
reset role;
select is((select status from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from inst)), 'canceled', 'the attempt was canceled in the portal');
select throws_ok($$update public.dues_payments set status = 'succeeded' where id = (select (r ->> 'payment_id')::uuid from inst)$$, '23000', null,
  'a canceled row still cannot be marked paid by hand');

set local role service_role;
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from inst), 'succeeded', 'evt_late',
  '{"method":"card","brand":"visa","last4":"4242","payment_intent_id":"pi_late","charge_id":"ch_late","occurred_at":"2026-09-02T15:00:00Z"}'),
  'applied', 'Stripe''s success is applied instead of ignored');
reset role;
select is((select status from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from inst)), 'succeeded', 'the row is now paid');
select ok((select receipt_no is not null from public.dues_payments where id = (select (r ->> 'payment_id')::uuid from inst)), 'and has a receipt number');
select is((select amount_paid_cents from public.dues_charges where id = (select id from ch)), 15000, 'the household is credited');
select is((select status from public.dues_installments where seq = 1), 'paid', 'the first installment is paid');
select is((select count(*)::int from public.notifications where kind = 'payment_revived' and recipient_user_id = '00000000-0000-0000-0000-0000000000a1'), 1,
  'administrators are told to check for a second payment');
select is((select count(*)::int from public.notifications where kind = 'payment_received' and recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 1,
  'the family is told once');
set local role service_role;
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from inst), 'succeeded', 'evt_late', '{}'), 'applied', 'the same event again is harmless');
reset role;
select is((select amount_paid_cents from public.dues_charges where id = (select id from ch)), 15000, 'and not counted twice');

-- A bank transfer that starts clearing after it was canceled, while a new attempt is open.
set local role service_role;
create temp table ach as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), false) as r;
select public.billing_cancel_payment((select (r ->> 'payment_id')::uuid from ach), 'Switched to the app''s payment sheet.');
create temp table fresh as select public.billing_begin_payment('00000000-0000-0000-0000-0000000000b1', (select id from ch), false) as r;
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from ach), 'processing', 'evt_ach1', '{"method":"us_bank_account"}'),
  'flagged', 'clearing while another attempt is open: administrators are told, the row waits');
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from ach), 'succeeded', 'evt_ach2', '{"method":"us_bank_account"}'),
  'applied', 'once it settles it is credited');
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from fresh), 'canceled', 'evt_x', '{}'), 'applied', 'the other attempt can still be closed');
select is(public.billing_apply_payment_update((select (r ->> 'payment_id')::uuid from fresh), 'failed', 'evt_y', '{"failure_message":"x"}'),
  'ignored', 'a canceled attempt that fails at Stripe stays canceled');
reset role;

select * from finish();
rollback;
