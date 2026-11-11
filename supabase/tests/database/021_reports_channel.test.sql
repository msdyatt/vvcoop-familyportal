-- #Reports: the administrators-only channel that reported messages and photos land in.
-- Fixtures: A1 and A4 administrators; T teacher; P1 and P3 parents (both in C1 with T);
-- DA a reviewer (demo) administrator and DP a reviewer parent.
begin;
select plan(35);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'admin4@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e1', 'demoadmin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e2', 'demoparent@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set is_demo = true where email in ('demoadmin@t.test', 'demoparent@t.test');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a4', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000e1', 'admin'),
  ('00000000-0000-0000-0000-0000000000e2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f3', 'Three');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'K3');
insert into public.classes (id, title, grades, active) values ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', 'active');
insert into storage.objects (bucket_id, name, owner_id) values
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', '00000000-0000-0000-0000-0000000000b3'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', '00000000-0000-0000-0000-0000000000b3'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/full.jpg', '00000000-0000-0000-0000-0000000000b3'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/thumb.jpg', '00000000-0000-0000-0000-0000000000b3');
insert into public.photos (id, storage_path, thumb_path, caption, visibility, status, uploaded_by, approved_by, approved_at) values
  ('00000000-0000-0000-0000-0000000000e1', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', 'Field day', 'coop', 'published', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', now()),
  ('00000000-0000-0000-0000-0000000000e2', 'library/00000000-0000-0000-0000-0000000000e2/full.jpg', 'library/00000000-0000-0000-0000-0000000000e2/thumb.jpg', 'Picnic', 'coop', 'published', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', now());

-- ---- the channel and who is in it ----------------------------------------------
select is((select count(*)::int from public.conversations where system_key = 'reports' and kind = 'channel' and audience = 'admins' and posting = 'everyone' and archived_at is null), 1, 'the Reports channel exists, for administrators');
select set_config('test.reports', (select id::text from public.conversations where system_key = 'reports'), true);
select is((select array_agg(user_id order by user_id)::text from public.conversation_members where conversation_id = current_setting('test.reports')::uuid),
  '{00000000-0000-0000-0000-0000000000a1,00000000-0000-0000-0000-0000000000a4}', 'its members are the administrators and no one else');
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.reports')::uuid and user_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'a reviewer administrator is not in it');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.conversations where system_key = 'reports'), 0, 'a parent cannot see the channel');
select throws_ok($$select public.send_message(current_setting('test.reports')::uuid, 'hello')$$, 'P0001', 'You are not part of that conversation.', 'or write in it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.conversations where system_key = 'reports'), 0, 'nor can a teacher');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.conversations where system_key = 'reports'), 0, 'nor a reviewer administrator');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.leave_conversation(current_setting('test.reports')::uuid)$$, 'P0001', null, 'an administrator cannot leave it by accident');
select throws_ok($$select public.archive_channel(current_setting('test.reports')::uuid, true)$$, 'P0001', 'The built-in channels can''t be archived.', 'or archive it');
select throws_ok($$select public.add_channel_members(current_setting('test.reports')::uuid, array['00000000-0000-0000-0000-0000000000b1']::uuid[])$$, 'P0001', null, 'or add a parent to it');
select throws_ok($$select public.remove_channel_member(current_setting('test.reports')::uuid, '00000000-0000-0000-0000-0000000000a4')$$, 'P0001', null, 'or remove another administrator by hand');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.set_conversation_muted(current_setting('test.reports')::uuid, true)$$, 'an administrator can mute it');
reset role;

-- ---- a reported message -----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.direct', public.start_direct_conversation('00000000-0000-0000-0000-0000000000a2')::text, true);
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select public.send_message(current_setting('test.direct')::uuid, 'rude words here');
select public.send_message(current_setting('test.direct')::uuid, 'second thing');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.report_message((select id from public.messages where body = 'rude words here'), 'This was unkind')$$, 'a member can report a message');
select public.report_message((select id from public.messages where body = 'rude words here'), 'This was unkind');
select throws_ok($$select public.report_message((select id from public.messages where system_label is not null limit 1), 'x')$$, 'P0001', null, 'and cannot report the system''s own cards');
reset role;

select is((select count(*)::int from public.messages where conversation_id = current_setting('test.reports')::uuid and body like 'New report: message%'), 1, 'one card was posted, and reporting twice did not post another');
select ok((select body like '%p1 reported a message from teacher in a direct message.%Reason: This was unkind%rude words here%' from public.messages where conversation_id = current_setting('test.reports')::uuid and body like 'New report: message%'), 'it names who reported, the reason and a snippet');
select is((select link_path from public.messages where conversation_id = current_setting('test.reports')::uuid and body like 'New report: message%'),
  '/family-village/admin?tab=message-reports#report-' || (select id::text from public.message_reports limit 1), 'and links to the review screen');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messages where conversation_id = current_setting('test.reports')::uuid), 1, 'an administrator reads the card');
select is((select last_sender_name from public.my_conversations() where system_key = 'reports'), 'Reports', 'and the list shows it came from Reports');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.messages where system_label is not null), 0, 'while the person who was reported cannot');
reset role;

select is((select count(*)::int from public.notifications where kind = 'message' and subject_id = current_setting('test.reports')::uuid and recipient_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'an unmuted administrator is notified once');
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.reports')::uuid and recipient_user_id = '00000000-0000-0000-0000-0000000000a4'), 0, 'a muted administrator is not');
select is((select count(*)::int from public.notifications where kind in ('message_report', 'photo_report')), 0, 'and the old notification to every administrator is gone');

-- ---- resolving: remove ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.resolve_message_report((select id from public.message_reports limit 1), 'remove', null)$$, 'an administrator removes the reported message on the review screen');
reset role;
select is((select count(*)::int from public.messages where body = 'Resolved: message removed by admin1.' and reply_to = (select root_message_id from public.report_threads where kind = 'message')), 1, 'and a "Resolved" reply lands under the card');
select ok((select body not like '%rude words here%' and body like '%Message: (removed)' from public.messages where body like 'New report: message%'), 'the removed words no longer sit in the card');

-- ---- resolving: dismiss ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select public.report_message((select id from public.messages where body = 'second thing'), 'Still unkind');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.resolve_message_report((select id from public.message_reports where reason = 'Still unkind'), 'dismiss', null);
reset role;
select is((select count(*)::int from public.messages where body = 'Resolved: dismissed by admin1.'), 1, 'dismissing posts "Resolved: dismissed" too');

-- ---- a reported photo --------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.report_photo('00000000-0000-0000-0000-0000000000e1', 'Not mine to share')$$, 'a member can report a photo');
select public.report_photo('00000000-0000-0000-0000-0000000000e2', 'Also unsure');
reset role;
select ok((select body like 'New report: photo%p1 reported a photo added by p3.%Caption: Field day%Reason: Not mine to share' and body not like '%library/%' from public.messages where body like '%Field day%'), 'the photo card has the essentials and no file path');
select ok((select link_path like '/family-village/admin?tab=message-reports#photo-report-%' from public.messages where body like '%Field day%'), 'and a link to the review screen');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.resolve_photo_report((select id from public.photo_reports where reason = 'Not mine to share'), 'remove');
select public.resolve_photo_report((select id from public.photo_reports where reason = 'Also unsure'), 'dismiss');
reset role;
select is((select count(*)::int from public.messages where body = 'Resolved: photo removed by admin1.' and reply_to is not null), 1, 'removing the photo posts "Resolved: photo removed" under its card');
select is((select count(*)::int from public.messages where body = 'Resolved: dismissed by admin1.'), 2, 'and dismissing the other posts its own');

-- ---- membership follows roles ---------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a4' and role = 'admin';
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.reports')::uuid and user_id = '00000000-0000-0000-0000-0000000000a4'), 0, 'someone who stops being an administrator leaves the channel');
insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a2', 'admin');
select is((select count(*)::int from public.conversation_members where conversation_id = current_setting('test.reports')::uuid and user_id = '00000000-0000-0000-0000-0000000000a2'), 1, 'and a new administrator joins it');

-- ---- erasure --------------------------------------------------------------------------------------
delete from auth.users where id = '00000000-0000-0000-0000-0000000000b1';
select ok((select not bool_or(body like '%p1%') from public.messages where conversation_id = current_setting('test.reports')::uuid), 'when a reporter''s account is deleted, their name leaves the cards');

select * from finish();
rollback;
