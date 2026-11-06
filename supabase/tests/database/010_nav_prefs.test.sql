begin;
select plan(6);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000e1', 'nav-a@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e2', 'nav-b@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email in ('nav-a@t.test', 'nav-b@t.test');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;

select lives_ok($$insert into public.user_nav_prefs (user_id, prefs) values ('00000000-0000-0000-0000-0000000000e1', '{"home":["home","photos"]}')$$, 'a member can save their own bar');
select is((select count(*)::int from public.user_nav_prefs), 1, 'and read it back');
select throws_ok($$insert into public.user_nav_prefs (user_id, prefs) values ('00000000-0000-0000-0000-0000000000e2', '{}')$$, '42501', null, 'but cannot save one for someone else');
select throws_ok($$update public.user_nav_prefs set prefs = '[1]' where user_id = '00000000-0000-0000-0000-0000000000e1'$$, '23514', null, 'the prefs must be an object');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}', true);
select is((select count(*)::int from public.user_nav_prefs), 0, 'another member cannot see it');
update public.user_nav_prefs set prefs = '{"home":[]}' where user_id = '00000000-0000-0000-0000-0000000000e1';
reset role;
select is((select prefs::text from public.user_nav_prefs where user_id = '00000000-0000-0000-0000-0000000000e1'), '{"home": ["home", "photos"]}', 'or change it');

select * from finish();
rollback;
