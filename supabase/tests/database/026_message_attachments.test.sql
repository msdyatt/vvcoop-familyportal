-- Several photos and files in one message. Fixtures as in 005: A administrator, T teacher
-- of C1, P1 and P1b one household in C1, P2 in C1, P3 only in C2. Everyone is in
-- the shared General channel, which is where these tests talk.
begin;
select plan(17);

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


select set_config('test.p', 'messages/' || current_setting('test.general') || '/', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.send_message(current_setting('test.general')::uuid, 'Trip photos and the form', null, null, '{}',
  jsonb_build_array(
    jsonb_build_object('path', current_setting('test.p') || 'a.jpg', 'name', 'a.jpg', 'mime', 'image/jpeg', 'size', 1200),
    jsonb_build_object('path', current_setting('test.p') || 'form.pdf', 'name', 'Permission form.pdf', 'mime', 'application/pdf', 'size', 52000),
    jsonb_build_object('path', current_setting('test.p') || 'b.jpg', 'name', 'b.jpg', 'mime', 'image/jpeg', 'size', 1300)))$$, 'a message can carry photos and a file');
reset role;
select set_config('test.m', (select id::text from public.messages where body = 'Trip photos and the form'), true);
select is((select count(*)::int from public.message_attachments where message_id = current_setting('test.m')::uuid), 3, 'all three are stored');
select is((select array_agg(kind order by position)::text from public.message_attachments where message_id = current_setting('test.m')::uuid), '{image,file,image}', 'in the order they were added, photos and files told apart');
select is((select image_path from public.messages where id = current_setting('test.m')::uuid), current_setting('test.p') || 'a.jpg', 'the first photo is also kept as the message''s photo');

-- everyone in the conversation sees them; people outside a private channel do not
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_attachments where message_id = current_setting('test.m')::uuid), 3, 'a member of the channel sees the attachments');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Planning', null, 'everyone', 'invite');
select public.send_message((select id from public.conversations where title = 'Planning'), 'plan',
  null, null, '{}', jsonb_build_array(jsonb_build_object('path', 'messages/' || (select id::text from public.conversations where title = 'Planning') || '/p.pdf', 'name', 'p.pdf', 'mime', 'application/pdf', 'size', 10)));
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_attachments where name = 'p.pdf'), 0, 'a person outside a private channel does not see its attachments');
reset role;

-- the rules
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, 'too many', null, null, '{}',
  (select jsonb_agg(jsonb_build_object('path', current_setting('test.p') || g || '.jpg', 'name', g || '.jpg', 'mime', 'image/jpeg', 'size', 10)) from generate_series(1, 11) g))$$,
  'P0001', 'Add up to 10 photos or files to one message.', 'at most ten attachments');
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, 'wrong folder', null, null, '{}',
  jsonb_build_array(jsonb_build_object('path', 'messages/00000000-0000-0000-0000-000000000999/x.pdf', 'name', 'x.pdf', 'mime', 'application/pdf', 'size', 10)))$$,
  'P0001', 'One of the attachments is not in this conversation.', 'an attachment has to be in the conversation''s own folder');
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, 'program', null, null, '{}',
  jsonb_build_array(jsonb_build_object('path', current_setting('test.p') || 'x.exe', 'name', 'x.exe', 'mime', 'application/x-msdownload', 'size', 10)))$$,
  'P0001', null, 'a kind of file the app does not offer is refused');
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, 'huge', null, null, '{}',
  jsonb_build_array(jsonb_build_object('path', current_setting('test.p') || 'big.pdf', 'name', 'big.pdf', 'mime', 'application/pdf', 'size', 20000000)))$$,
  'P0001', 'Each file can be up to 10 MB.', 'a file over 10 MB is refused');
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, null)$$, 'P0001', 'Write a message or add a photo or file.', 'a message still needs something in it');

-- files with no words: allowed, and the list and the notification say what was sent
delete from public.notifications;
select lives_ok($$select public.send_message(current_setting('test.general')::uuid, null, null, null, '{}',
  jsonb_build_array(
    jsonb_build_object('path', current_setting('test.p') || 'c.pdf', 'name', 'c.pdf', 'mime', 'application/pdf', 'size', 100),
    jsonb_build_object('path', current_setting('test.p') || 'd.pdf', 'name', 'd.pdf', 'mime', 'application/pdf', 'size', 100)))$$, 'two files with no words can be sent');
reset role;
select is((select body from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a1' and title like '%p1' limit 1), 'Sent 2 files', 'the notification says what was sent');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select last_preview from public.my_conversations() where system_key = 'general'), 'Sent 2 files', 'and so does the conversation list');
reset role;

-- removing the message removes the attachments and says which files to delete
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select public.delete_own_message(current_setting('test.m')::uuid)),
  current_setting('test.p') || 'a.jpg' || E'\n' || current_setting('test.p') || 'b.jpg' || E'\n' || current_setting('test.p') || 'form.pdf', 'removing returns every file path');
reset role;
select is((select count(*)::int from public.message_attachments where message_id = current_setting('test.m')::uuid), 0, 'and the attachments are gone');

select * from finish();
rollback;
