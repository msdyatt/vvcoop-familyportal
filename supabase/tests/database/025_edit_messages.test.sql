-- Editing your own message. Fixtures as in 005: A administrator, T teacher
-- of C1, P1 and P1b one household in C1, P2 in C1, P3 only in C2. Everyone is in
-- the shared General channel, which is where these tests talk.
begin;
select plan(12);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p1b@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p3@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000b4', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'), ('00000000-0000-0000-0000-0000000000f3', 'Three');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b4', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'K2'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'K3');
insert into public.classes (id, title, grades, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Class Two', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c2', 'active'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c3', 'active');


select set_config('test.general', (select id::text from public.conversations where system_key = 'general'), true);
select set_config('test.announce', (select id::text from public.conversations where system_key = 'announcements'), true);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message(current_setting('test.general')::uuid, 'Anyone driving Friday?');
reset role;
select set_config('test.first', (select id::text from public.messages where body = 'Anyone driving Friday?'), true);


select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.edit_own_message(current_setting('test.first')::uuid, 'Anyone driving Saturday?')$$, 'a sender can edit their own message');
reset role;
select is((select body from public.messages where id = current_setting('test.first')::uuid), 'Anyone driving Saturday?', 'the new words are shown');
select ok((select edited_at is not null from public.messages where id = current_setting('test.first')::uuid), 'and it is marked as edited');
select is((select body from public.message_edits where message_id = current_setting('test.first')::uuid), 'Anyone driving Friday?', 'the words before the edit are kept');

-- the history is for administrators
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_edits), 0, 'the sender cannot read the edit history');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_edits), 1, 'an administrator can');
reset role;

-- not someone else's message
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.edit_own_message(current_setting('test.first')::uuid, 'hijacked')$$, 'P0001', 'You can only edit your own messages.', 'nobody else can edit it');
reset role;

-- not empty, not too long
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.edit_own_message(current_setting('test.first')::uuid, '   ')$$, 'P0001', 'A message needs some words or a photo.', 'an edit cannot leave it empty');
select throws_ok($$select public.edit_own_message(current_setting('test.first')::uuid, repeat('x', 4001))$$, 'P0001', 'That message is too long.', 'or too long');
reset role;

-- only for 24 hours
update public.messages set created_at = now() - interval '25 hours' where id = current_setting('test.first')::uuid;
set local role authenticated;
select throws_ok($$select public.edit_own_message(current_setting('test.first')::uuid, 'too late')$$, 'P0001', 'Messages can be edited for 24 hours after they are sent.', 'an old message cannot be edited');
reset role;

-- not a removed message
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message(current_setting('test.general')::uuid, 'Oops');
select public.delete_own_message((select id from public.messages where body = 'Oops'));
reset role;
set local role authenticated;
select throws_ok($$select public.edit_own_message((select id from public.messages where deleted_at is not null limit 1), 'back again')$$, 'P0001', 'You can only edit your own messages.', 'a removed message cannot be edited');
reset role;

-- not a system card
insert into public.messages (conversation_id, sender_id, body, system_label) values (current_setting('test.general')::uuid, null, 'Report received', 'Report');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.edit_own_message((select id from public.messages where system_label = 'Report'), 'rewritten')$$, 'P0001', 'You can only edit your own messages.', 'a system message cannot be edited');
reset role;

select * from finish();
rollback;
