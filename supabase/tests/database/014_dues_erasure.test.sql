-- A member erasing their account must not erase the co-op's payment records:
-- the household is kept (renamed, without its children or documents) when it
-- has billing history, and removed outright when it has none.
begin;
select plan(8);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'paid@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'nopay@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Paid'), ('00000000-0000-0000-0000-0000000000f2', 'Unpaid');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent');
insert into public.children (family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'K1'), ('00000000-0000-0000-0000-0000000000f2', 'K2');
insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000e0', '2026-27', true);
insert into public.requirements (id, school_year_id, kind, title, amount_per_family)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e0', 'dues', 'Dues', 300);
insert into public.dues_charges (requirement_id, family_id, school_year_id, subtotal_cents)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e0', 30000);
insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode, occurred_at)
select id, family_id, 'charge', 30000, 'card', 'succeeded', 'portal', true, now() from public.dues_charges;

select lives_ok($$select public.erase_account_data('00000000-0000-0000-0000-0000000000b1', true)$$, 'a member with billing history can erase their account, household and all');
select is((select display_name from public.families where id = '00000000-0000-0000-0000-0000000000f1'), 'Former household', 'their household is kept, without its name');
select ok((select records_retained_at is not null from public.families where id = '00000000-0000-0000-0000-0000000000f1'), 'and marked as kept for records');
select is((select count(*)::int from public.children where family_id = '00000000-0000-0000-0000-0000000000f1'), 0, 'its children are gone');
select is((select count(*)::int from public.dues_payments where family_id = '00000000-0000-0000-0000-0000000000f1'), 1, 'the payment record is still there');
select is((select amount_cents from public.dues_payments where family_id = '00000000-0000-0000-0000-0000000000f1'), 30000, 'with its amount');

select lives_ok($$select public.erase_account_data('00000000-0000-0000-0000-0000000000b2', true)$$, 'a member with none erases normally');
select is((select count(*)::int from public.families where id = '00000000-0000-0000-0000-0000000000f2'), 0, 'and their household is deleted');

select * from finish();
rollback;
