-- The rules that keep one person's account from damaging another's, and that
-- have each already broken once in production:
--   * profile / child self-service triggers (VV-04, and its service-role and
--     SQL-editor regressions of 28 Aug)
--   * an admin removing their own access mid-flow (28 Aug)
--   * a new column added without the UPDATE grant the admin screens need
--     (children.family_id on 27 Aug, classes.capacity on 5 Nov)
-- Each test file runs in its own transaction that is rolled back.
begin;
select plan(25);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'b@t.test',     'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@t.test',     'authenticated', 'authenticated');
update public.profiles set status = 'active' where email in ('admin@t.test', 'b@t.test', 'c@t.test');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'parent'),
  ('00000000-0000-0000-0000-00000000000c', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Bee'),
  ('00000000-0000-0000-0000-0000000000f2', 'Cee');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000a', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000c', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'Kid');

-- ---- profile self-update guard --------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$update public.profiles set display_name = 'Bee Two' where id = '00000000-0000-0000-0000-00000000000b'$$,
  'a person can edit their own display name');

do $$ begin
  begin update public.profiles set email = 'stolen@t.test' where id = '00000000-0000-0000-0000-00000000000b';
  exception when others then null; end;
end $$;

select lives_ok(
  $$update public.profiles set status = 'removed' where id = '00000000-0000-0000-0000-00000000000b'$$,
  'a person can remove their own account');

reset role;
select is((select email from public.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'b@t.test',
  'a person cannot change their own email');
select is((select status::text from public.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'removed',
  'self-removal took effect');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
do $$ begin
  begin update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-00000000000b';
  exception when others then null; end;
end $$;
reset role;
select is((select status::text from public.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'removed',
  'a removed person cannot reactivate themselves');

-- the backend (edge functions, service role) activates invited accounts
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok(
  $$update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-00000000000b'$$,
  'the service role can reactivate an account (invite-family-admin depends on this)');
reset role;
select is((select status::text from public.profiles where id = '00000000-0000-0000-0000-00000000000b'), 'active',
  'and it stuck');

-- direct database access (the SQL editor, migrations) carries no JWT at all
select set_config('request.jwt.claims', '', true);
select lives_ok(
  $$update public.profiles set status = 'removed' where id = '00000000-0000-0000-0000-00000000000b'$$,
  'direct database access can remove an account');
select lives_ok(
  $$update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-00000000000b'$$,
  'and restore it (the 28 Aug lockout fix)');

-- ---- child self-service guard ---------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$update public.children set birthdate = '2015-05-05' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'a family can set their child''s birthdate');
do $$ begin
  begin update public.children set first_name = 'Renamed' where id = '00000000-0000-0000-0000-0000000000e1';
  exception when others then null; end;
  begin update public.children set family_id = '00000000-0000-0000-0000-0000000000f2' where id = '00000000-0000-0000-0000-0000000000e1';
  exception when others then null; end;
  begin update public.children set active = false where id = '00000000-0000-0000-0000-0000000000e1';
  exception when others then null; end;
end $$;
reset role;
select is((select first_name from public.children where id = '00000000-0000-0000-0000-0000000000e1'), 'Kid',
  'a family cannot rename a child');
select is((select family_id from public.children where id = '00000000-0000-0000-0000-0000000000e1'), '00000000-0000-0000-0000-0000000000f1'::uuid,
  'a family cannot move a child to another household');
select is((select active from public.children where id = '00000000-0000-0000-0000-0000000000e1'), true,
  'a family cannot deactivate a child');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$update public.children set first_name = 'Kiddo' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'an admin can rename a child');
select lives_ok(
  $$update public.children set family_id = '00000000-0000-0000-0000-0000000000f2' where id = '00000000-0000-0000-0000-0000000000e1'$$,
  'an admin can move a child to another household');
reset role;
select is((select family_id from public.children where id = '00000000-0000-0000-0000-0000000000e1'), '00000000-0000-0000-0000-0000000000f2'::uuid,
  'and the move happened');

-- ---- an admin cannot remove their own access ------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
delete from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000a';
delete from public.family_members where user_id = '00000000-0000-0000-0000-00000000000a';
delete from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000b';
delete from public.family_members where user_id = '00000000-0000-0000-0000-00000000000b';
reset role;
select is((select count(*)::int from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000a'), 1,
  'an admin cannot delete their own role');
select is((select count(*)::int from public.family_members where user_id = '00000000-0000-0000-0000-00000000000a'), 1,
  'an admin cannot delete their own household membership');
select is((select count(*)::int from public.user_roles where user_id = '00000000-0000-0000-0000-00000000000b'), 0,
  'an admin can remove someone else''s role');
select is((select count(*)::int from public.family_members where user_id = '00000000-0000-0000-0000-00000000000b'), 0,
  'an admin can remove someone else''s household membership');

-- ---- column grants the admin screens depend on ----------------------------
select ok(has_column_privilege('authenticated', 'public.classes', 'capacity', 'UPDATE'),
  'classes.capacity is updatable (Admin -> Classes -> Save sends it)');
select ok(has_column_privilege('authenticated', 'public.children', 'family_id', 'UPDATE'),
  'children.family_id is updatable (moving a child)');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE'),
  'profiles.email is not updatable by signed-in users');

-- ---- who may call the secret-handling functions ---------------------------
select ok(
  not has_function_privilege('anon', 'public.read_vault_secret(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.read_vault_secret(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.read_vault_secret(text)', 'EXECUTE'),
  'only the service role can read Vault secrets');
select ok(
  not has_function_privilege('anon', 'public.vault_create_secret_if_absent(text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.vault_create_secret_if_absent(text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.vault_create_secret_if_absent(text,text)', 'EXECUTE'),
  'only the service role can write Vault secrets');

select * from finish();
rollback;
