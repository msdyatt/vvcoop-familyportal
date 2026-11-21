-- More of the co-op's look: the longer heading font list, the body font, the header and sidebar styles and the small
-- touches (migration 20261120130000_coop_style).
-- Fixtures: A1 administrator; P1 parent; D1 reviewer (demo) administrator.
begin;
select plan(22);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'demo@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000d1', 'admin');

-- ---- defaults, readable by anyone ------------------------------------------------------------------------------------
set local role anon;
select is((select body_font from public.coop_settings), 'inter', 'the text font starts as Inter');
select is((select header_style || '/' || sidebar_style from public.coop_settings), 'plain/plain', 'the header and sidebar start plain');
select is((select whimsy from public.coop_settings),
  '{"greeting":true,"village":true,"season":"auto","marker":"diamond","quill":true,"motion":true}'::jsonb,
  'every small touch starts on, with the season by the calendar and a diamond marker');
reset role;

-- ---- who may save ------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_style('lexend', 'ink', 'ink', '{}'::jsonb)$$,
  '42501', 'Administrator access is required.', 'a parent cannot change the style');
select throws_ok($$update public.coop_settings set header_style = 'ink'$$, '42501', null, 'nor write the table');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_style('lexend', 'ink', 'ink', '{}'::jsonb)$$,
  '42501', 'Administrator access is required.', 'nor can a reviewer administrator');
reset role;

-- ---- saving -------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_coop_style('atkinson', 'ink', 'tint', '{"season":"winter","marker":"star","quill":false}'::jsonb)$$,
  'an administrator saves a text font, styles and some small touches');
select is((select body_font from public.coop_settings), 'atkinson', 'the text font is kept');
select is((select header_style || '/' || sidebar_style from public.coop_settings), 'ink/tint', 'and the header and sidebar styles');
select is((select whimsy from public.coop_settings),
  '{"greeting":true,"village":true,"season":"winter","marker":"star","quill":false,"motion":true}'::jsonb,
  'touches left out keep their defaults');
select is((select count(*)::int from public.audit_log where action = 'coop_style_updated'), 1, 'the change is in the audit log');

select throws_ok($$select public.admin_save_coop_style('comic-sans', 'plain', 'plain', '{}'::jsonb)$$,
  'P0001', 'Choose a text font from the list.', 'a text font that is not on the list is refused');
select throws_ok($$select public.admin_save_coop_style('inter', 'rainbow', 'plain', '{}'::jsonb)$$,
  'P0001', 'Choose a header style from the list.', 'so is an unknown header style');
select throws_ok($$select public.admin_save_coop_style('inter', 'plain', 'neon', '{}'::jsonb)$$,
  'P0001', 'Choose a sidebar style from the list.', 'and an unknown sidebar style');
select throws_ok($$select public.admin_save_coop_style('inter', 'plain', 'plain', '{"confetti":true}'::jsonb)$$,
  'P0001', 'Unknown small touch.', 'a small touch that does not exist is refused');
select throws_ok($$select public.admin_save_coop_style('inter', 'plain', 'plain', '{"marker":"skull"}'::jsonb)$$,
  'P0001', 'One of the small touches has a value that is not on the list.', 'so is a marker shape that is not on the list');
select throws_ok($$select public.admin_save_coop_style('inter', 'plain', 'plain', '{"village":"yes"}'::jsonb)$$,
  'P0001', 'One of the small touches has a value that is not on the list.', 'and an on/off touch that is not true or false');

-- The longer heading font list. (The Veritas palette is written out: a signed-in caller may not run private.default_coop_accent.)
select lives_ok($$select public.admin_save_coop_settings('Veritas Village', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'fraunces', null, null)$$,
  'a heading font from the longer list can be saved');
select is((select heading_font from public.coop_settings), 'fraunces', 'and is kept');
select throws_ok($$select public.admin_save_coop_settings('Veritas Village', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'papyrus', null, null)$$,
  'P0001', 'Choose a heading font from the list.', 'a heading font that is not on the list is still refused');

-- Reset brings all of it back.
select lives_ok($$select public.admin_reset_coop_appearance()$$, 'an administrator resets the look');
select is((select body_font || '/' || header_style || '/' || sidebar_style || '/' || (whimsy->>'marker') || '/' || heading_font from public.coop_settings),
  'inter/plain/plain/diamond/playfair', 'the fonts, styles and small touches are back to the Veritas Village look');
reset role;

select * from finish();
rollback;
