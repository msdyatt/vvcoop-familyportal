-- Your own header and sidebar colours, and the longer palette list (issue #140, follow-on): who may set them, the
-- contrast check on a band, and Reset.
-- Fixtures: A1 administrator; P1 parent.
begin;
select plan(19);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent');

-- Bands as lib/coop-theme.ts bandFamily makes them: a dark green (cream text, same at night) and a light sand
-- (navy text, a deep night version).
select is(private.coop_band_problems('{"bg":"#2e6b4f","fg":"#faf7f1","bg_night":"#2e6b4f","fg_night":"#faf7f1"}'), '{}'::text[], 'a dark band with cream text passes');
select is(private.coop_band_problems('{"bg":"#f2d6a0","fg":"#0b2a3d","bg_night":"#493400","fg_night":"#faf7f1"}'), '{}'::text[], 'a light band with navy text and a deep night passes');
select is(private.coop_band_problems('{"bg":"#7a7a7a","fg":"#faf7f1","bg_night":"#383838","fg_night":"#faf7f1"}'),
  array['Text would be hard to read on this colour (4.01:1, needs 4.5:1). Choose a lighter or darker shade.'], 'a mid grey is refused, with the reason');
select is(private.coop_band_problems('{"bg":"#f2d6a0","fg":"#0b2a3d","bg_night":"#f2d6a0","fg_night":"#faf7f1"}'),
  array['Text would be hard to read on it in the dark theme (1.31:1, needs 4.5:1).'], 'a light band cannot be used as is at night');
select is(private.coop_band_problems('{"bg":"#2e6b4f","fg":"#ffff00","bg_night":"#2e6b4f","fg_night":"#faf7f1"}'),
  array['The text on it has to be cream or navy.'], 'the text is cream or navy, nothing else');
select is(private.coop_band_problems('{"bg":"#2e6b4f"}'), array['Choose a colour.'], 'a band needs all four colours');

-- ---- saving -------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_style('inter', 'custom', 'plain', '{}'::jsonb,
  '{"bg":"#2e6b4f","fg":"#faf7f1","bg_night":"#2e6b4f","fg_night":"#faf7f1"}'::jsonb, null)$$,
  '42501', 'Administrator access is required.', 'a parent cannot set a header colour');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_coop_style('inter', 'custom', 'custom', '{}'::jsonb,
  '{"bg":"#2E6B4F","fg":"#faf7f1","bg_night":"#2e6b4f","fg_night":"#faf7f1"}'::jsonb,
  '{"bg":"#f2d6a0","fg":"#0b2a3d","bg_night":"#493400","fg_night":"#faf7f1"}'::jsonb)$$, 'an administrator sets both bands to their own colours');
select is((select header_style || ' ' || sidebar_style from public.coop_settings), 'custom custom', 'both are "your own colour"');
select is((select header_band->>'bg' from public.coop_settings), '#2e6b4f', 'colours are kept in lower case');
select throws_like($$select public.admin_save_coop_style('inter', 'custom', 'plain', '{}'::jsonb,
  '{"bg":"#7a7a7a","fg":"#faf7f1","bg_night":"#383838","fg_night":"#faf7f1"}'::jsonb, null)$$,
  'The header colour cannot be used: Text would be hard to read on this colour (4.01:1%', 'a colour the text cannot be read on is refused');
select throws_ok($$select public.admin_save_coop_style('inter', 'plain', 'custom', '{}'::jsonb, null, null)$$,
  'P0001', 'Choose a colour for the sidebar.', '"your own colour" needs a colour');
select lives_ok($$select public.admin_save_coop_style('inter', 'ink', 'plain', '{}'::jsonb,
  '{"bg":"#2e6b4f","fg":"#faf7f1","bg_night":"#2e6b4f","fg_night":"#faf7f1"}'::jsonb, null)$$, 'switching to another style keeps the colour for later');
select is((select header_style || ' ' || (header_band->>'bg') from public.coop_settings), 'ink #2e6b4f', 'and it is still there');
select throws_ok($$update public.coop_settings set header_style = 'custom', header_band = null$$, '42501', null, 'the table itself is not writable');

-- ---- more palettes for members ------------------------------------------------------------------------------------------
select lives_ok($$select public.admin_set_personal_palettes('{veritas,berry,marigold}')$$, 'the new ready-made palettes can be offered');
select is((select personal_palettes from public.coop_settings), '{veritas,berry,marigold}'::text[], 'in the ready-made order');

-- ---- reset ------------------------------------------------------------------------------------------------------------------
select lives_ok($$select public.admin_reset_coop_appearance()$$, 'reset to the default look');
select is((select header_style || ' ' || coalesce(header_band::text, 'no colour') from public.coop_settings), 'plain no colour', 'clears the colours too');
reset role;

select * from finish();
rollback;
