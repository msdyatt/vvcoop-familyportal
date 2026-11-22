-- The page's colours (issue #140, follow-on): ink, light grounds and dark grounds; who may set them, the rule that
-- keeps them readable, and Reset.
-- Fixtures: A1 administrator; P1 parent.
begin;
select plan(18);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent');

-- ---- the rule -----------------------------------------------------------------------------------------------------------
select is(private.coop_page_problems('#0b2a3d', '{"ground":"#faf7f1","surface":"#fffdf9","sunken":"#f2eee5","panel":"#e6e9e2"}',
  '{"canvas":"#08202f","surface":"#0e3045","sunken":"#061a27","panel":"#143a45","band":"#0d3a57","field":"#0b2a3d"}'), '{}'::text[],
  'the Veritas colours pass');
select is(private.coop_page_problems('#3d1220', '{"ground":"#ffffff","surface":"#ffffff","sunken":"#f4f5f6","panel":"#eceff1"}',
  '{"canvas":"#000000","surface":"#121212","sunken":"#000000","panel":"#1c1c1c","band":"#1f1f1f","field":"#121212"}'), '{}'::text[],
  'a burgundy ink, clean white and true black pass');
select is(private.coop_page_problems(null, null, null), '{}'::text[], 'nothing chosen is the Veritas look');
select is(private.coop_page_problems('#2f6b8a', null, null),
  array['This colour is too light for text and buttons: it needs to be at least as deep as the portal''s navy. Choose a darker shade.'],
  'an ink lighter than navy is refused');
select is(private.coop_page_problems(null, '{"ground":"#faf7f1","surface":"#fffdf9","sunken":"#f2eee5","panel":"#cfd4cc"}', null),
  array['The panel colour is too dark for the light theme: text needs it at least as light as the portal''s own. Choose a paler tint.'],
  'a light ground darker than Veritas is refused');
select is(private.coop_page_problems(null, null, '{"canvas":"#08202f","surface":"#0e3045","sunken":"#061a27","panel":"#143a45","band":"#2b6a8f","field":"#0b2a3d"}'),
  array['The dark theme''s band colour is too light: light text needs it at least as deep as the portal''s own night.'],
  'a night ground lighter than Veritas is refused');
select is(private.coop_page_problems(null, '{"ground":"#ffffff"}', null), array['Choose a page colour.'], 'a page needs all four colours');

-- ---- saving -------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_page('burgundy', '#3d1220', 'parchment', null, 'navy-night', null)$$,
  '42501', 'Administrator access is required.', 'a parent cannot change the page colours');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_coop_page('burgundy', '#3D1220', 'white',
  '{"ground":"#ffffff","surface":"#ffffff","sunken":"#f4f5f6","panel":"#eceff1"}'::jsonb, 'black',
  '{"canvas":"#000000","surface":"#121212","sunken":"#000000","panel":"#1c1c1c","band":"#1f1f1f","field":"#121212"}'::jsonb)$$,
  'an administrator saves an ink, a page and a dark theme');
select is((select ink || ' ' || ink_id || ' ' || ground_id || ' ' || night_id from public.coop_settings), '#3d1220 burgundy white black', 'all kept, lower case');
select throws_like($$select public.admin_save_coop_page('custom', '#2f6b8a', 'parchment', null, 'navy-night', null)$$,
  'These colours cannot be used: This colour is too light for text and buttons%', 'a light ink is refused, with the reason');
select throws_ok($$select public.admin_save_coop_page('Bad Id', null, 'parchment', null, 'navy-night', null)$$,
  'P0001', 'Choose the ink, page and dark theme from the lists.', 'ids are plain');
select lives_ok($$select public.admin_save_coop_page('custom', null, 'custom', null, 'custom', null)$$, 'no colours means the Veritas ones');
select is((select coalesce(ink, '-') || ' ' || ink_id || ' ' || ground_id || ' ' || night_id from public.coop_settings), '- navy parchment navy-night', 'with their own names');
select throws_ok($$update public.coop_settings set ink = '#ffffff'$$, '42501', null, 'the table itself is not writable');

-- ---- reset -------------------------------------------------------------------------------------------------------------------
select lives_ok($$select public.admin_save_coop_page('plum', '#2b1638', 'parchment', null, 'navy-night', null)$$, 'a plum ink again');
select lives_ok($$select public.admin_reset_coop_appearance()$$, 'reset');
reset role;
select is((select coalesce(ink, '-') || ' ' || ink_id from public.coop_settings), '- navy', 'clears the ink back to navy');

select * from finish();
rollback;
