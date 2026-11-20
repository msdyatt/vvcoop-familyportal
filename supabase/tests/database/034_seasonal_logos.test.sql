-- Seasonal logos (issue #140 part 3, #110): who can read and change them, what a variant must have, and the bucket's
-- seasonal folder. Which variant shows on a day is decided in the page (tests/coop-theme.test.mjs).
-- Fixtures: A1 administrator; P1 parent; D1 reviewer (demo) administrator.
begin;
select plan(20);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'demo@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000d1', 'admin');

-- ---- uploading -------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'seasonal/p.png')$$, '42501', null,
  'a parent cannot upload a seasonal logo');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'auto', 'seasonal/h.png', null, null, null)$$,
  '42501', 'Administrator access is required.', 'nor save one');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'auto', 'seasonal/h.png', null, null, null)$$,
  '42501', 'Administrator access is required.', 'nor can a reviewer administrator');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'seasonal/harvest.png'), ('coop-brand', 'seasonal/winter-dark.webp')$$,
  'an administrator uploads into the seasonal folder');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'auto', 'seasonal/missing.png', null, null, null)$$,
  'P0001', 'Upload the file first.', 'a variant needs its files uploaded');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'auto', null, null, null, null)$$,
  'P0001', 'Upload at least one logo for it.', 'and at least one of them');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'auto', 'logo_light/x.png', null, null, null)$$,
  'P0001', 'That is not a seasonal logo file.', 'only from the seasonal folder');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-31', '2026-10-01', false, 'auto', 'seasonal/harvest.png', null, null, null)$$,
  'P0001', 'It has to end on or after the day it starts.', 'a one-off range must run forwards');
select throws_ok($$select public.admin_save_logo_variant(null, 'Harvest', '2026-10-01', '2026-10-31', false, 'sometimes', 'seasonal/harvest.png', null, null, null)$$,
  'P0001', 'Choose when it shows.', 'the override is one of auto, on, off');
select lives_ok($$select public.admin_save_logo_variant(null, ' Harvest ', '2026-10-01', '2026-10-31', false, 'auto', 'seasonal/harvest.png', null, null, null, 3.1)$$,
  'an administrator saves a dated variant');
select lives_ok($$select public.admin_save_logo_variant(null, 'Winter', '2026-12-15', '2026-01-06', true, 'auto', null, 'seasonal/winter-dark.webp', null, null)$$,
  'and a yearly one that runs over New Year');
select is((select string_agg(name || ':' || yearly || ':' || coalesce(logo_ratio::text, '-'), ',' order by name) from public.coop_logo_variants),
  'Harvest:false:3.100,Winter:true:-', 'both are kept, the name trimmed, the shape only with a light lockup');
select lives_ok(format($$select public.admin_save_logo_variant(%L, 'Harvest', '2026-10-01', '2026-10-31', false, 'on', 'seasonal/harvest.png', null, null, null, 3.1)$$,
  (select id from public.coop_logo_variants where name = 'Harvest')), 'an administrator turns one on now');
select is((select override from public.coop_logo_variants where name = 'Harvest'), 'on', 'the override is kept');
select throws_ok($$update public.coop_logo_variants set override = 'off'$$, '42501', null, 'the table itself is not writable');
reset role;

-- ---- reading ---------------------------------------------------------------------------------------------------------
set local role anon;
select is((select count(*)::int from public.coop_logo_variants), 2, 'the sign-in page can read the variants');
reset role;

-- ---- removing --------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(format($$select public.admin_delete_logo_variant(%L)$$, (select id from public.coop_logo_variants where name = 'Winter')),
  '42501', 'Administrator access is required.', 'a parent cannot remove one');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_delete_logo_variant((select id from public.coop_logo_variants where name = 'Winter')), '{seasonal/winter-dark.webp}'::text[],
  'an administrator removes one and gets its files back to tidy up');
select is((select count(*)::int from public.coop_logo_variants), 1, 'it is gone');
reset role;
select is((select count(*)::int from public.audit_log where action like 'coop_logo_variant_%'), 4, 'every save and removal is in the activity log');

select * from finish();
rollback;
