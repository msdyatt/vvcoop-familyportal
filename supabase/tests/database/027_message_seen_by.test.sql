-- Who has seen a message, for the people who run a channel. Fixtures as in 005: A administrator, T teacher
-- of C1, P1 and P1b one household in C1, P2 in C1, P3 only in C2. Everyone is in
-- the shared General channel, which is where these tests talk.
begin;
select plan(9);

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
select public.send_message(current_setting('test.general')::uuid, 'Picture day moved');
reset role;
select set_config('test.m', (select id::text from public.messages where body = 'Picture day moved'), true);

-- a1 (admin) and b2 have opened the channel since; a2, b3, b4 have not
update public.conversation_members set last_read_at = now() + interval '1 hour'
  where conversation_id = current_setting('test.general')::uuid and user_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2');
update public.conversation_members set last_read_at = now() - interval '1 hour'
  where conversation_id = current_setting('test.general')::uuid and user_id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b4');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select seen_count from public.message_seen_counts(current_setting('test.general')::uuid, array[current_setting('test.m')::uuid])), 2, 'an administrator sees how many have read it');
select is((select total_count from public.message_seen_counts(current_setting('test.general')::uuid, array[current_setting('test.m')::uuid])), 5, 'out of everyone who could, not counting the sender');
select is((select count(*)::int from public.message_seen_by(current_setting('test.m')::uuid) where seen), 2, 'and who has');
select is((select string_agg(display_name, ',' order by display_name) from public.message_seen_by(current_setting('test.m')::uuid) where not seen), 'p2,p3,teacher', 'and who has not');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select * from public.message_seen_counts(current_setting('test.general')::uuid, array[current_setting('test.m')::uuid])$$, 'a teacher can ask');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.message_seen_counts(current_setting('test.general')::uuid, array[current_setting('test.m')::uuid])$$, 'P0001', 'Only administrators and teachers can see who has read a message.', 'a parent cannot');
select throws_ok($$select * from public.message_seen_by(current_setting('test.m')::uuid)$$, 'P0001', 'Only administrators and teachers can see who has read a message.', 'nor for one message');
reset role;

-- not in a direct message
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message(public.start_direct_conversation('00000000-0000-0000-0000-0000000000a2'), 'hello');
select throws_ok($$select * from public.message_seen_by((select id from public.messages where body = 'hello'))$$, 'P0001', 'Only administrators and teachers can see who has read a message.', 'a direct message has no read status');
reset role;

-- not in a channel you are not part of
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Carpool', null, 'everyone', 'invite');
select public.send_message((select id from public.conversations where title = 'Carpool'), 'ride?');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select * from public.message_seen_by((select id from public.messages where body = 'ride?'))$$, 'P0001', 'Only administrators and teachers can see who has read a message.', 'a teacher who is not in a private channel cannot ask about it');
reset role;

select * from finish();
rollback;
