begin;
select plan(5);

insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email = 'p1@t.test';

select is((select onboarding_version from public.profiles where email = 'p1@t.test'), 0, 'a new account has not done the tour');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.complete_onboarding(2)$$, 'a person can record that they finished the tour');
select lives_ok($$select public.complete_onboarding(1)$$, 'an older version does not matter');
select throws_ok($$update public.profiles set onboarding_version = 0 where id = '00000000-0000-0000-0000-0000000000b1'$$, '42501', null, 'but the value cannot be edited directly');
reset role;
select is((select onboarding_version from public.profiles where email = 'p1@t.test'), 2, 'and it never moves backwards');

select * from finish();
rollback;
