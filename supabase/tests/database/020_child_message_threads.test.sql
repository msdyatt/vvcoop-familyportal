-- "Message the parents": one thread per (teacher, child), started from either side.
-- Fixtures: A admin; T teacher of C1; T2 teacher of C2 only.
--   F1: parents P1 and P1b (both in the portal), child K1 in C1
--   F2: parent P2 in the portal, parent P2n invited but not yet joined, child K2 in C1
--   F3: parent P3, child K3 in C2
--   F4: only an invited, not-yet-joined parent, child K4 in C1
-- DT / DP are a reviewer (demo) teacher and parent with a demo child.
begin;
select plan(41);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'teacher2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p1b@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b5', 'p2n@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b6', 'p4n@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e1', 'demoteacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e2', 'demoparent@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1)
  where email in ('admin@t.test', 'teacher@t.test', 'teacher2@t.test', 'p1@t.test', 'p1b@t.test', 'p2@t.test', 'p3@t.test', 'demoteacher@t.test', 'demoparent@t.test');
-- p2n and p4n stay 'pending': an account exists, they have not joined yet.
update public.profiles set display_name = 'James' where email = 'p2n@t.test';
update public.profiles set display_name = 'Pat' where email = 'p4n@t.test';
update public.profiles set is_demo = true where email in ('demoteacher@t.test', 'demoparent@t.test');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000a3', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000b4', 'parent'),
  ('00000000-0000-0000-0000-0000000000e1', 'teacher'),
  ('00000000-0000-0000-0000-0000000000e2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'),
  ('00000000-0000-0000-0000-0000000000f3', 'Three'), ('00000000-0000-0000-0000-0000000000f4', 'Four'),
  ('00000000-0000-0000-0000-0000000000f9', 'Demo');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b5', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b4', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b6', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000e2', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'Ella'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'Finn'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'Gus'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000f4', 'Hana'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000f9', 'Demo Kid');
insert into public.classes (id, title, grades, active, is_demo) values
  ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true, false),
  ('00000000-0000-0000-0000-0000000000d2', 'Class Two', '{}', true, false),
  ('00000000-0000-0000-0000-0000000000d9', 'Demo Class', '{}', true, true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a3', 'lead'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000e1', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c2', 'active'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c3', 'active'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', 'active'),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000c9', 'active');

-- ---- who may call it ------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.start_child_conversation(uuid, uuid)', 'execute'), 'a signed-out visitor cannot call it');
select ok(has_function_privilege('authenticated', 'public.start_child_conversation(uuid, uuid)', 'execute'), 'a signed-in member can');

-- ---- teacher side ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.k1', public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')::text, true);
select ok(current_setting('test.k1')::uuid is not null, 'a teacher can open a thread for a student in their class');
select is(public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')::text, current_setting('test.k1'), 'asking again returns the same thread');
select is((select count(*)::int from public.conversations where child_id = '00000000-0000-0000-0000-0000000000c1'), 1, 'and there is still only one thread for that student and teacher');
select is((select title from public.conversations where id = current_setting('test.k1')::uuid), 'Ella · teacher', 'it is titled with the student''s first name and the teacher''s name');
select is((select count(*)::int from public.my_conversations() where child_thread), 1, 'the list marks it as a conversation about a student');
reset role;
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k1')::uuid), 3, 'it holds the teacher and both parents');
select is((select array_agg(user_id order by user_id)::text from public.conversation_members where conversation_id = current_setting('test.k1')::uuid),
  '{00000000-0000-0000-0000-0000000000a2,00000000-0000-0000-0000-0000000000b1,00000000-0000-0000-0000-0000000000b2}', 'and nobody else, so no other family is in it');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c3')$$, 'P0001', 'You can''t message about that student.', 'a teacher cannot start one for a student outside their classes');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c9')$$, 'P0001', 'You can''t message about that student.', 'nor for a student in a reviewer class');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3')$$, 'P0001', 'You can''t message about that student.', 'nor by naming another teacher as if they were a parent');
reset role;

-- a student with only one parent in the portal
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.k2', public.start_child_conversation('00000000-0000-0000-0000-0000000000c2')::text, true);
select is((select array_agg(display_name order by display_name) from public.conversation_people(current_setting('test.k2')::uuid)), array['p2', 'teacher'], 'with one parent in the portal, the thread holds just that parent and the teacher');
select is(public.child_thread_not_in_portal(current_setting('test.k2')::uuid), array['James'], 'and the teacher is told who is not in the portal yet');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
set local role authenticated;
select is(public.child_thread_not_in_portal(current_setting('test.k2')::uuid), array['James'], 'and so is the parent');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is(public.child_thread_not_in_portal(current_setting('test.k2')::uuid), '{}'::text[], 'someone outside the thread learns nothing about it');
reset role;

-- the other parent joins later and is added without anyone doing anything
select set_config('request.jwt.claims', '', true);
update public.profiles set status = 'active' where email = 'p2n@t.test';
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k2')::uuid), 3, 'a parent who joins the portal later is added to the thread');

-- a student whose parents are all still waiting to join
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c4')$$, 'P0001', 'No parent or guardian of this student is in the portal yet.', 'with no parent in the portal at all, the teacher is told so plainly');
reset role;

-- ---- parent side ---------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is(public.start_child_conversation('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2')::text, current_setting('test.k1'), 'the other parent, starting from their side, gets the same thread');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')$$, 'P0001', 'You can''t message about that student.', 'a parent must say which teacher');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3')$$, 'P0001', 'You can''t message about that student.', 'and it must be a teacher of their child''s class');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a3')$$, 'P0001', 'You can''t message about that student.', 'a parent cannot start one about someone else''s child');
reset role;

-- a thread started by a parent first includes the other parent and is the one the teacher finds later
select set_config('request.jwt.claims', '', true);
delete from public.conversations where id = current_setting('test.k1')::uuid;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.k1', public.start_child_conversation('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a2')::text, true);
reset role;
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k1')::uuid), 3, 'a parent starting it first still brings in the other parent and the teacher');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')::text, current_setting('test.k1'), 'and the teacher opening it later finds that same thread');
reset role;

-- ---- who can see it -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.send_message(current_setting('test.k1')::uuid, 'Ella did great this week')$$, 'the teacher can write in it');
reset role;
select is((select count(*)::int from public.notifications where kind = 'message' and recipient_user_id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2')), 2, 'both parents are notified');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messages where conversation_id = current_setting('test.k1')::uuid), 0, 'another family cannot read it');
select throws_ok($$select public.send_message(current_setting('test.k1')::uuid, 'hello?')$$, 'P0001', 'You are not part of that conversation.', 'or write in it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.conversations where child_id is not null), 0, 'a teacher of another class cannot see it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.conversations where child_id is not null), 0, 'and an administrator cannot browse it');
reset role;

-- ---- staying in it ------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.leave_conversation(current_setting('test.k1')::uuid)$$, 'P0001', 'A conversation about a student can''t be left. Mute it to stop its notifications.', 'a parent cannot leave it');
select lives_ok($$select public.set_conversation_muted(current_setting('test.k1')::uuid, true)$$, 'but can mute it');
reset role;

-- ---- membership follows the facts -----------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
delete from public.family_members where family_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-0000000000b2';
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k1')::uuid and user_id = '00000000-0000-0000-0000-0000000000b2'), 0, 'an adult removed from the household leaves the thread');
update public.enrollments set status = 'withdrawn' where child_id = '00000000-0000-0000-0000-0000000000c1';
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k1')::uuid and user_id = '00000000-0000-0000-0000-0000000000a2'), 0, 'a teacher no longer teaching the student leaves it');
select is((select count(*)::int from public.messages where conversation_id = current_setting('test.k1')::uuid), 1, 'the history stays');
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.k1')::uuid and user_id = '00000000-0000-0000-0000-0000000000b1'), 1, 'and the remaining parent keeps it');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')$$, 'P0001', 'You can''t message about that student.', 'and cannot open a new one for a student they no longer teach');
reset role;

-- ---- blocks and reviewer accounts ------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into public.user_blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a2');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2')$$, 'P0001', 'You can''t message that person.', 'a parent who blocked the teacher cannot start one with them');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c9')$$, 'a reviewer teacher can open one for the reviewer class''s student');
select throws_ok($$select public.start_child_conversation('00000000-0000-0000-0000-0000000000c1')$$, 'P0001', 'You can''t message about that student.', 'but not for a real student');
reset role;
select is((select array_agg(user_id order by user_id)::text from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.child_id = '00000000-0000-0000-0000-0000000000c9'),
  '{00000000-0000-0000-0000-0000000000e1,00000000-0000-0000-0000-0000000000e2}', 'it holds only reviewer accounts');

select * from finish();
rollback;
