-- Web push subscriptions, the notification inbox, and invitation acceptance.
begin;
select plan(16);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'b@t.test',     'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@t.test',     'authenticated', 'authenticated');
update public.profiles set status = 'active' where email in ('admin@t.test', 'b@t.test', 'c@t.test');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'parent'),
  ('00000000-0000-0000-0000-00000000000c', 'parent');

-- ---- push subscriptions ----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.register_push_subscription('https://push.example/E1', 'key1', 'auth1', 'Phone')$$,
  'a person can register a device');
select lives_ok($$select public.register_push_subscription('https://push.example/E1', 'key2', 'auth2', 'Phone')$$,
  'registering the same device again refreshes it');
select throws_ok($$select public.register_push_subscription('http://push.example/E9', 'k', 'a', 'x')$$,
  'P0001', 'That is not a valid push endpoint.', 'a non-https endpoint is refused');
reset role;
select is((select count(*)::int from public.push_subscriptions where endpoint = 'https://push.example/E1'), 1,
  'a device is stored once, however often it registers');

-- one phone, signed out of B and into C: the row moves, it does not duplicate
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.register_push_subscription('https://push.example/E1', 'key3', 'auth3', 'Phone')$$,
  'the next person to use the phone can register it');
reset role;
select is((select user_id from public.push_subscriptions where endpoint = 'https://push.example/E1'), '00000000-0000-0000-0000-00000000000c'::uuid,
  'the device now belongs to them, so the first person stops receiving it');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select public.unregister_push_subscription('https://push.example/E1');
select is((select count(*)::int from public.push_subscriptions where user_id = '00000000-0000-0000-0000-00000000000c'), 0,
  'a person cannot see anyone else''s devices');
reset role;
select is((select count(*)::int from public.push_subscriptions where endpoint = 'https://push.example/E1'), 1,
  'and cannot unregister a device that is not theirs');

set local role anon;
select throws_ok($$select public.register_push_subscription('https://push.example/E2', 'k', 'a', 'x')$$,
  '42501', null, 'a signed-out visitor cannot register a device');
reset role;

-- ---- notifications ---------------------------------------------------------
insert into public.notifications (id, recipient_user_id, kind, title) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 'test', 'Hello B'),
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000c', 'test', 'Hello C');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$update public.notifications set read_at = now() where id = '00000000-0000-0000-0000-0000000000b1'$$,
  'a person can mark their own notification read');
select throws_ok($$update public.notifications set title = 'Edited' where id = '00000000-0000-0000-0000-0000000000b1'$$,
  'P0001', 'A recipient may only mark a notification read.', 'and can change nothing else about it');
select is((select count(*)::int from public.notifications where id = '00000000-0000-0000-0000-0000000000c1'), 0,
  'and cannot see anyone else''s notifications');
reset role;

-- ---- invitation acceptance -------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000d', 'd@t.test', 'authenticated', 'authenticated');
insert into public.invitations (email, invited_by_user_id, token_hash, expires_at) values
  ('d@t.test', '00000000-0000-0000-0000-00000000000a', 'hash-d', now() + interval '1 day'),
  ('e@t.test', '00000000-0000-0000-0000-00000000000a', 'hash-e', now() + interval '1 day');
select is((select accepted_at from public.invitations where email = 'd@t.test'), null,
  'an invitation starts out unaccepted');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-00000000000d';
select ok((select accepted_at is not null from public.invitations where email = 'd@t.test'),
  'confirming the invited account marks its invitation accepted');
select ok((select accepted_at is null from public.invitations where email = 'e@t.test'),
  'and leaves everyone else''s invitation alone');

select ok(exists (select 1 from cron.job where jobname = 'deliver-push'), 'the push delivery job is scheduled');

select * from finish();
rollback;
