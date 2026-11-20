-- The co-op's settings and look (issue #140): who can read them, who can change them, the contrast check on a
-- palette, the logo slots and the logo bucket.
-- Fixtures: A1 administrator; A2 administrator with a second factor; P1 parent; D1 reviewer (demo) administrator.
begin;
select plan(51);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'demo@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000d1', 'admin');
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a2', 'totp', 'verified', now(), now());

-- ---- contrast arithmetic ----------------------------------------------------------------------------------------
select is(round(private.contrast_ratio('#000000', '#ffffff')::numeric, 2), 21.00, 'black on white is 21:1');
select is(round(private.contrast_ratio('#bb6141', '#faf7f1')::numeric, 2), 4.01, 'terracotta on cream is 4.01:1, as the stylesheet says');
select is(private.coop_accent_problems(private.default_coop_accent()), '{}'::text[], 'the Veritas palette passes every check');
select is(private.default_coop_accent(), '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'and is the same as lib/coop-theme.ts VERITAS_ACCENT');

-- ---- reading ----------------------------------------------------------------------------------------------------------
set local role anon;
select is((select name from public.coop_settings), 'Veritas Village', 'the sign-in page (signed out) can read the name');
select is((select palette_id from public.coop_settings), 'veritas', 'and the palette, which starts as Veritas');
select throws_ok($$update public.coop_settings set name = 'X'$$, '42501', null, 'someone signed out cannot change it');
select throws_ok($$select public.admin_save_coop_settings('X', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', null, null)$$,
  '42501', null, 'nor call the save function');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.coop_settings), 1, 'a parent can read the settings');
select throws_ok($$update public.coop_settings set name = 'Parent Co-op'$$, '42501', null, 'a parent cannot write the table');
select throws_ok($$insert into public.coop_settings (id) values ('other')$$, '42501', null, 'nor add a second row');
select throws_ok($$select public.admin_save_coop_settings('Parent Co-op', 'veritas', '{}'::jsonb, 'playfair', null, null)$$,
  '42501', 'Administrator access is required.', 'a parent cannot save settings');
select throws_ok($$select public.admin_reset_coop_appearance()$$, '42501', 'Administrator access is required.', 'or reset them');
select throws_ok($$select public.admin_set_coop_logo('logo_light', null)$$, '42501', 'Administrator access is required.', 'or change a logo');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'logo_light/parent.png')$$,
  '42501', null, 'or upload into the logo bucket');
reset role;

-- A reviewer account is never an administrator of the real co-op.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_settings('Demo', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', null, null)$$,
  '42501', 'Administrator access is required.', 'a reviewer administrator cannot save settings');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'logo_light/demo.png')$$,
  '42501', null, 'nor upload a logo');
reset role;

-- An administrator with a second factor must have used it.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_coop_settings('Two', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', null, null)$$,
  '42501', 'Complete two-factor verification before continuing.', 'an administrator at aal1 cannot save');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_coop_settings('Veritas Village', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', null, null)$$,
  'at aal2 they can');
reset role;

-- ---- saving ------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_coop_settings('  Riverbend Co-op ', 'meadow',
  '{"accent":"#4F8A55","accent_text":"#427d49","accent_on_ink":"#8cc991","accent_deep":"#0a4a18","accent_tint":"#d4ecd5",
    "accent_tint_ink":"#073e13","night_ink":"#8cc991","night_fill":"#427d49","night_tint":"#1f4424","night_tint_ink":"#cee6cf"}'::jsonb,
  'georgia', ' office@riverbend.test ', '(555) 010-0199')$$, 'an administrator saves a ready-made palette, a name and a contact');
select is((select name from public.coop_settings), 'Riverbend Co-op', 'the name is trimmed');
select is((select accent->>'accent' from public.coop_settings), '#4f8a55', 'colours are stored in lower case');
select is((select heading_font from public.coop_settings), 'georgia', 'the heading font is kept');
select is((select support_email from public.coop_settings), 'office@riverbend.test', 'the support email is trimmed');
select is((select updated_by from public.coop_settings), '00000000-0000-0000-0000-0000000000a1'::uuid, 'and who changed it is recorded');

select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#f5d76e","accent_text":"#427d49","accent_on_ink":"#8cc991","accent_deep":"#0a4a18","accent_tint":"#d4ecd5",
    "accent_tint_ink":"#073e13","night_ink":"#8cc991","night_fill":"#427d49","night_tint":"#1f4424","night_tint_ink":"#cee6cf"}'::jsonb,
  'playfair', null, null)$$, 'This palette cannot be used: Too close to its background for lines and large headings on the page (1.32:1, needs 3:1).%',
  'a pale accent is refused, with the reason in plain words');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#4f8a55","accent_text":"#8cc991","accent_on_ink":"#8cc991","accent_deep":"#0a4a18","accent_tint":"#d4ecd5",
    "accent_tint_ink":"#073e13","night_ink":"#8cc991","night_fill":"#427d49","night_tint":"#1f4424","night_tint_ink":"#cee6cf"}'::jsonb,
  'playfair', null, null)$$, '%small accent text on the page%', 'small accent text that is too light is refused');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#4f8a55","accent_text":"#427d49","accent_on_ink":"#427d49","accent_deep":"#0a4a18","accent_tint":"#d4ecd5",
    "accent_tint_ink":"#073e13","night_ink":"#8cc991","night_fill":"#427d49","night_tint":"#1f4424","night_tint_ink":"#cee6cf"}'::jsonb,
  'playfair', null, null)$$, '%accent text on navy bands and buttons%', 'accent text that is too dark for the navy band is refused');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#4f8a55","accent_text":"#427d49","accent_on_ink":"#8cc991","accent_deep":"#0a4a18","accent_tint":"#d4ecd5",
    "accent_tint_ink":"#073e13","night_ink":"#8cc991","night_fill":"#8cc991","night_tint":"#1f4424","night_tint_ink":"#cee6cf"}'::jsonb,
  'playfair', null, null)$$, '%button labels in the dark theme%', 'a night button fill that cream text cannot sit on is refused');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom', '{"accent":"#4f8a55"}'::jsonb, 'playfair', null, null)$$,
  '%missing its accent text colour%', 'a palette with colours missing is refused');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb || '{"danger_fill":"#00ff00"}'::jsonb, 'playfair', null, null)$$,
  '%a colour this version does not know%', 'a palette cannot carry anything else (alert colours are not themeable)');
select throws_like($$select public.admin_save_coop_settings('Riverbend', 'custom',
  '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb || '{"accent":"red"}'::jsonb, 'playfair', null, null)$$,
  '%missing its accent colour%', 'a colour has to be #rrggbb');
select is((select palette_id from public.coop_settings), 'meadow', 'nothing refused was saved');

select throws_ok($$select public.admin_save_coop_settings('', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', null, null)$$,
  'P0001', 'Give the co-op a name of up to 80 characters.', 'the name cannot be empty');
select throws_ok($$select public.admin_save_coop_settings('X', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'comic-sans', null, null)$$,
  'P0001', 'Choose a heading font from the list.', 'the font must be one of the safe list');
select throws_ok($$select public.admin_save_coop_settings('X', 'veritas', '{"accent":"#bb6141","accent_text":"#a85539","accent_on_ink":"#d7a590","accent_deep":"#6b3826","accent_tint":"#efd9cd","accent_tint_ink":"#4a2417","night_ink":"#e8a98d","night_fill":"#a85539","night_tint":"#5b3324","night_tint_ink":"#f6d9cb"}'::jsonb, 'playfair', 'not an email', null)$$,
  'P0001', 'The support email does not look like an email address.', 'the support email must look like one');
reset role;
select is((select count(*)::int from public.audit_log where action = 'coop_settings_updated'), 2, 'each save is in the activity log');

-- ---- logos -------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_coop_logo('logo_light', 'logo_light/new.png', 3.2)$$,
  'P0001', 'Upload the file first.', 'a logo must be uploaded before it is used');
select lives_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'logo_light/new.png')$$,
  'an administrator uploads a logo into its slot folder');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'other/new.png')$$,
  '42501', null, 'but not outside the slot folders');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('coop-brand', 'logo_light/new.svg')$$,
  '42501', null, 'nor as SVG');
select throws_ok($$select public.admin_set_coop_logo('logo_dark', 'logo_light/new.png')$$,
  'P0001', 'That is not a logo file for this slot.', 'a file is used only in its own slot');
select throws_ok($$select public.admin_set_coop_logo('logo_light', 'logo_light/new.png', 9)$$,
  'P0001', 'A lockup should be between 1 and 6 times as wide as it is tall.', 'an odd shape is refused');
select lives_ok($$select public.admin_set_coop_logo('logo_light', 'logo_light/new.png', 3.2)$$, 'the uploaded file becomes the light logo');
select is((select logo_light_path || ' ' || logo_ratio from public.coop_settings), 'logo_light/new.png 3.200', 'with its shape');
select lives_ok($$select public.admin_set_coop_logo('logo_light', null)$$, 'clearing a slot goes back to the bundled logo');
select is((select coalesce(logo_light_path, 'none') || ' ' || coalesce(logo_ratio::text, 'none') from public.coop_settings), 'none none', 'and forgets the shape');

-- ---- reset ------------------------------------------------------------------------------------------------------------------
select lives_ok($$select public.admin_set_coop_logo('logo_light', 'logo_light/new.png', 3.2)$$, 'a logo again');
select lives_ok($$select public.admin_reset_coop_appearance()$$, 'reset to the default look');
select is((select palette_id || ' ' || heading_font || ' ' || coalesce(logo_light_path, 'no logo') from public.coop_settings),
  'veritas playfair no logo', 'brings back the Veritas palette, font and logos');
select is((select name from public.coop_settings), 'Riverbend Co-op', 'and keeps the name');
reset role;

select * from finish();
rollback;
