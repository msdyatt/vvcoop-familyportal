-- Personal appearance (issue #140, part 2): the co-op's list of palettes members may pick, and each person's own
-- choices kept in their own preferences row.
-- Fixtures: A1 administrator; P1 and P2 parents; D1 reviewer (demo) administrator.
begin;
select plan(14);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'demo@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1);
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent'), ('00000000-0000-0000-0000-0000000000d1', 'admin');

select is((select personal_palettes from public.coop_settings), '{veritas,meadow,harbor,plum,teal,ochre}'::text[],
  'every ready-made palette is offered to members at first');

set local role anon;
select is((select personal_palettes from public.coop_settings), '{veritas,meadow,harbor,plum,teal,ochre}'::text[], 'the list is readable before sign-in, with the rest of the settings');
reset role;

-- ---- the co-op's list ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_personal_palettes('{meadow}')$$, '42501', 'Administrator access is required.', 'a parent cannot change the list');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_personal_palettes('{meadow}')$$, '42501', 'Administrator access is required.', 'nor can a reviewer administrator');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_personal_palettes('{teal,meadow,meadow}')$$, 'an administrator narrows the list');
select is((select personal_palettes from public.coop_settings), '{meadow,teal}'::text[], 'kept in the ready-made order, without repeats');
select throws_ok($$select public.admin_set_personal_palettes('{meadow,neon}')$$, 'P0001', 'Only the ready-made palettes can be offered to members.', 'an unknown palette is refused');
select throws_ok($$select public.admin_set_personal_palettes(array['meadow', null])$$, 'P0001', 'Only the ready-made palettes can be offered to members.', 'and so is an empty entry');
select lives_ok($$select public.admin_set_personal_palettes('{}')$$, 'an empty list turns personal palettes off');
select is((select personal_palettes from public.coop_settings), '{}'::text[], 'which is kept');
select throws_ok($$update public.coop_settings set personal_palettes = '{neon}'$$, '42501', null, 'the table itself is not writable');
reset role;
select is((select count(*)::int from public.audit_log where action = 'coop_personal_palettes_updated'), 2, 'each change is in the activity log');

-- ---- each person's own choices ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
insert into public.user_nav_prefs (user_id, prefs) values ('00000000-0000-0000-0000-0000000000b1', '{"theme":"dark","accent":"teal","textSize":"large"}');
select is((select prefs->>'textSize' from public.user_nav_prefs where user_id = '00000000-0000-0000-0000-0000000000b1'), 'large', 'a person keeps their choices on their account');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.user_nav_prefs), 0, 'and nobody else can read them');
reset role;

select * from finish();
rollback;
