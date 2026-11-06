-- Native (iOS/Android) device tokens live beside web subscriptions.
begin;
select plan(11);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000b', 'b@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email in ('b@t.test', 'c@t.test');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.register_device_token('fcm-token-1', 'ios', 'iPhone app')$$,
  'a signed-in person can register a phone');
select lives_ok($$select public.register_push_subscription('https://push.example/W1', 'k', 'a', 'Browser')$$,
  'and a browser too');
select throws_ok($$select public.register_device_token('t', 'windows', 'x')$$,
  'P0001', 'Unknown platform.', 'an unknown platform is refused');
select throws_ok($$select public.register_device_token('', 'ios', 'x')$$,
  'P0001', 'That is not a valid device token.', 'an empty token is refused');
reset role;
select is((select count(*)::int from public.push_subscriptions where user_id = '00000000-0000-0000-0000-00000000000b'), 2,
  'one person can have a phone and a browser');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public.register_device_token('fcm-token-1', 'ios', 'iPhone app');
reset role;
select is((select user_id from public.push_subscriptions where device_token = 'fcm-token-1'), '00000000-0000-0000-0000-00000000000c'::uuid,
  'a phone signed into another account moves to them instead of duplicating');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select public.unregister_device_token('fcm-token-1');
reset role;
select is((select count(*)::int from public.push_subscriptions where device_token = 'fcm-token-1'), 1,
  'and the previous owner cannot remove it');

set local role anon;
select throws_ok($$select public.register_device_token('fcm-token-2', 'android', 'x')$$,
  '42501', null, 'a signed-out visitor cannot register a phone');
reset role;

select throws_ok(
  $$insert into public.push_subscriptions (user_id, platform, device_token, endpoint) values ('00000000-0000-0000-0000-00000000000b', 'ios', 'x', 'https://both.example')$$,
  '23514', null, 'a row cannot be both a phone and a browser');
select throws_ok(
  $$insert into public.push_subscriptions (user_id, platform) values ('00000000-0000-0000-0000-00000000000b', 'web')$$,
  '23514', null, 'a browser row without its keys is refused');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public.unregister_device_token('fcm-token-1');
reset role;
select is((select count(*)::int from public.push_subscriptions where device_token = 'fcm-token-1'), 0,
  'the current owner can remove their phone');

select * from finish();
rollback;
