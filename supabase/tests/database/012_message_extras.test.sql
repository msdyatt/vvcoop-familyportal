-- Replies, reactions and mentions. Fixtures as in 005: A administrator, T teacher
-- of C1, P1 and P1b one household in C1, P2 in C1, P3 only in C2. Everyone is in
-- the shared General channel, which is where these tests talk.
begin;
select plan(16);

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

-- ---- replies --------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.send_message(current_setting('test.general')::uuid, 'I can', null, current_setting('test.first')::uuid)$$, 'a member can reply to a message');
select throws_ok($$select public.send_message(current_setting('test.announce')::uuid, 'wrong place', null, current_setting('test.first')::uuid)$$, 'P0001', 'That message is no longer here to reply to.', 'but not to a message in another conversation');
reset role;
select is((select reply_to::text from public.messages where body = 'I can'), current_setting('test.first'), 'the reply points at the original');

-- ---- reactions ------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(public.toggle_reaction(current_setting('test.first')::uuid, '👍'), true, 'a member can react');
select is(public.toggle_reaction(current_setting('test.first')::uuid, '👍'), false, 'reacting the same way again removes it');
select public.toggle_reaction(current_setting('test.first')::uuid, '❤️');
select throws_ok($$select public.toggle_reaction(current_setting('test.first')::uuid, '💩')$$, 'P0001', 'Choose one of the available reactions.', 'only the offered reactions are allowed');
select is((select count(*)::int from public.message_reactions), 1, 'a member sees the reactions on a message in their conversation');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_reactions), 1, 'everyone in a shared channel sees them');
reset role;
-- an invite-only channel's message is invisible to outsiders, and so are its reactions
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Planning', null, 'everyone', 'invite');
XX, '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message((select id from public.conversations where title = 'Planning'), 'private note');
select public.toggle_reaction((select id from public.messages where body = 'private note'), '🎉');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.message_reactions where emoji = '🎉'), 0, 'a non-member cannot see reactions in a private channel');
select throws_ok($$select public.toggle_reaction((select id from public.messages where body = 'private note'), '🎉')$$, 'P0001', 'You can''t react to that message.', 'or react in it');
reset role;

-- ---- mentions ---------------------------------------------------------------------------
-- T has muted the conversation; a mention still reaches them, once.
update public.conversation_members set muted = true
  where conversation_id = current_setting('test.general')::uuid and user_id = '00000000-0000-0000-0000-0000000000a2';
delete from public.notifications;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message(current_setting('test.general')::uuid, 'Thanks @teacher', null, null, array['00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b4']::uuid[]);
reset role;
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a2' and title like 'p1 mentioned you%'), 1, 'a mentioned person is notified, even with the conversation muted');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a2'), 1, 'and only once');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a1' and title like '%mentioned you%'), 0, 'people not mentioned get no mention notification');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'everyone else gets the ordinary notification');

-- Someone who is not in a private channel is ignored if named.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.send_message((select id from public.conversations where title = 'Planning'), 'ping @p3', null, null, array['00000000-0000-0000-0000-0000000000b4']::uuid[]);
reset role;
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b4' and title like '%mentioned you%' and body = 'ping @p3'), 0, 'naming someone outside the conversation does nothing');
select throws_ok($$select public.send_message(current_setting('test.general')::uuid, 'too many', null, null, (select array_agg(gen_random_uuid()) from generate_series(1, 21)))$$, 'P0001', null, 'a message can mention at most 20 people');

select * from finish();
rollback;
