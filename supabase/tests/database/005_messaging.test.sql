-- Messaging: who may talk to whom, who may read what, blocking, reporting,
-- class channels that follow enrollment, and photo storage access.
begin;
select plan(44);

-- People: A administrator, T teacher of class C1, P1 and P1b the two adults of
-- household F1 (child K1 in C1), P2 (household F2, child K2 in C1), P3
-- (household F3, child K3 in C2, which T does not teach).
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

-- These tests are about direct messages, groups and class channels. Every
-- active member is also placed in the co-op-wide channels (see 011), so take
-- the fixtures out of them here to keep the counts below about what they test.
delete from public.conversation_members m using public.conversations c
  where c.id = m.conversation_id and c.audience = 'everyone';

-- ---- who can message whom ---------------------------------------------------
select ok(private.can_message('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1'), 'a teacher can message the parent of a child in their class');
select ok(private.can_message('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b3'), 'two parents with children in the same class can message each other');
select ok(private.can_message('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2'), 'two adults of one household can');
select ok(private.can_message('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1'), 'anyone can message an administrator');
select ok(not private.can_message('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4'), 'parents with no class or household in common cannot');
select ok(not private.can_message('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b4'), 'a teacher cannot message a family outside their classes');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messageable_people()), 4, 'the directory a parent sees: teacher, administrator, the other household adult, the classmate parent');
select ok(not exists (select 1 from public.messageable_people() where user_id = '00000000-0000-0000-0000-0000000000b4'), 'and not the unconnected family');

-- ---- direct messages ---------------------------------------------------------
select lives_ok($$select public.start_direct_conversation('00000000-0000-0000-0000-0000000000a2')$$, 'a parent can start a conversation with their child''s teacher');
select throws_ok($$select public.start_direct_conversation('00000000-0000-0000-0000-0000000000b4')$$, 'P0001', 'You can''t message that person.', 'but not with someone outside their circle');
select public.start_direct_conversation('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from public.conversations), 1, 'the same two people share one direct conversation');

select lives_ok($$select public.send_message((select id from public.conversations limit 1), 'Hello teacher')$$, 'a member can send a message');
select throws_ok($$insert into public.messages (conversation_id, sender_id, body) values ((select id from public.conversations limit 1), '00000000-0000-0000-0000-0000000000b1', 'sneaky')$$, '42501', null, 'messages cannot be inserted directly, only through the function');
select throws_ok($$select public.send_message((select id from public.conversations limit 1), '   ')$$, 'P0001', 'Write a message or add a photo or file.', 'an empty message is refused');
reset role;

select is((select count(*)::int from public.notifications where kind = 'message' and recipient_user_id = '00000000-0000-0000-0000-0000000000a2'), 1, 'the teacher is notified of the message');
select is((select count(*)::int from public.notifications where kind = 'message' and recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'and the sender is not');

-- someone outside the conversation sees and can do nothing
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messages), 0, 'an outsider cannot read the conversation');
select throws_ok($$select public.send_message((select conversation_id from public.messages limit 1), 'hi')$$, 'P0001', null, 'an outsider cannot post in it');
reset role;
select throws_ok($$select public.send_message((select id from public.conversations limit 1), 'hi')$$, 'P0001', 'You are not part of that conversation.', 'nor can an administrator who is not a member');

-- ---- unread counts and read state --------------------------------------------
-- A test file is one transaction, so now() never advances; in real use a message
-- and the recipient's read marker come from different transactions. Backdate it.
update public.conversation_members set last_read_at = now() - interval '1 hour';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select unread_count from public.my_conversations() limit 1), 1, 'the teacher has one unread message');
select public.mark_conversation_read((select id from public.conversations limit 1));
select is((select unread_count from public.my_conversations() limit 1), 0, 'reading it clears the count');
select ok((select read_at is not null from public.notifications where kind = 'message' and recipient_user_id = '00000000-0000-0000-0000-0000000000a2' limit 1), 'and marks its notification read');

-- ---- blocking ----------------------------------------------------------------
select public.block_user('00000000-0000-0000-0000-0000000000b1');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.send_message((select id from public.conversations limit 1), 'are you there?')$$, 'P0001', 'You can no longer message this person.', 'a blocked person cannot message the blocker');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messages), 0, 'and the blocker no longer sees their earlier messages');
select public.unblock_user('00000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from public.messages), 1, 'unblocking brings them back');

-- ---- groups ------------------------------------------------------------------
select lives_ok($$select public.create_group_conversation('Class One parents', array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b3']::uuid[])$$, 'a teacher can start a group');
select throws_ok($$select public.create_group_conversation('Oops', array['00000000-0000-0000-0000-0000000000b4']::uuid[])$$, 'P0001', 'You can''t message everyone you chose.', 'but only with people they can message');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.create_group_conversation('Parents group', array['00000000-0000-0000-0000-0000000000b3']::uuid[])$$, 'P0001', 'Only teachers and administrators can start a group.', 'a parent cannot start a group');
reset role;

-- ---- class channels follow enrollment -------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.open_class_conversation('00000000-0000-0000-0000-0000000000d1')$$, 'P0001', null, 'a parent cannot open a class channel');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.open_class_conversation('00000000-0000-0000-0000-0000000000d1')$$, 'the class''s teacher can');
reset role;
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.kind = 'class'), 4, 'the channel holds the teacher and the three parents of enrolled children');
insert into public.enrollments (class_id, child_id, status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', 'active');
select ok(exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.kind = 'class' and m.user_id = '00000000-0000-0000-0000-0000000000b4'), 'enrolling a child adds their parent');
update public.enrollments set status = 'withdrawn' where child_id = '00000000-0000-0000-0000-0000000000c3' and class_id = '00000000-0000-0000-0000-0000000000d1';
select ok(not exists (select 1 from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.kind = 'class' and m.user_id = '00000000-0000-0000-0000-0000000000b4'), 'withdrawing a child removes their parent');

-- ---- reporting and moderation ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select public.send_message((select id from public.conversations where kind = 'class'), 'A rude message');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.report_message((select id from public.messages where body = 'A rude message'), 'This was unkind')$$, 'a member can report a message');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.report_message((select id from public.messages where body = 'A rude message'), 'spying')$$, 'P0001', 'You can only report messages in your own conversations.', 'a non-member cannot');
select throws_ok($$select * from public.admin_message_reports()$$, 'P0001', 'Administrator access is required.', 'and ordinary members cannot read the reports');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.admin_message_reports() where status = 'open'), 1, 'an administrator sees the open report');
select ok((select count(*) from public.admin_report_context((select id from public.admin_message_reports() limit 1))) >= 1, 'with the message and its context');
select public.resolve_message_report((select id from public.admin_message_reports() limit 1), 'remove', 'Removed');
reset role;
select ok((select body is null and deleted_at is not null from public.messages where id = (select message_id from public.message_reports limit 1)), 'removing a reported message erases its content');
select ok((select count(*) from public.audit_log where action in ('message_report_viewed', 'message_report_remove')) = 2, 'and both administrator steps are logged');

-- ---- photos -----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.send_message((select id from public.conversations where kind = 'direct'), null, 'messages/00000000-0000-0000-0000-000000000999/x.jpg')$$, '23514', null, 'a photo path must belong to the same conversation');
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('family-village-private', 'messages/' || (select id from public.conversations where kind = 'direct')::text || '/a.jpg', '00000000-0000-0000-0000-0000000000b1')$$, 'a member can upload a photo to their conversation''s folder');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('family-village-private', 'messages/' || (select id from public.conversations where kind = 'direct' limit 1)::text || '/b.jpg', '00000000-0000-0000-0000-0000000000b4')$$, '42501', null, 'an outsider cannot');
reset role;

-- ---- limits -----------------------------------------------------------------------
insert into public.messages (conversation_id, sender_id, body)
select (select id from public.conversations where kind = 'group' limit 1), '00000000-0000-0000-0000-0000000000a2', 'x' from generate_series(1, 30);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.send_message((select id from public.conversations where kind = 'group' limit 1), 'one more')$$, 'P0001', 'You are sending messages very quickly. Wait a moment and try again.', 'sending more than 30 messages in a minute is refused');
reset role;

select * from finish();
rollback;
