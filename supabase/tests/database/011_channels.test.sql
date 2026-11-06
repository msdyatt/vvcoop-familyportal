
-- Channels: the built-in ones, who may create more, class links, archiving, and
-- the link from news posts. Fixtures as in 005 (A admin, T teacher of C1, P1 and
-- P1b one household in C1, P2 in C1, P3 only in C2).
begin;
select plan(36);

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


-- A reviewer account and a brand-new member, to see who joins the shared channels.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000e1', 'newbie@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000e2', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email = 'newbie@t.test';
update public.profiles set is_demo = true, status = 'active' where email = 'reviewer@t.test';

-- ---- the built-in channels -----------------------------------------------------
select is((select count(*)::int from public.conversations where system_key in ('announcements', 'general')), 2, 'Announcements and General exist');
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id
           where c.audience = 'everyone' and m.user_id = '00000000-0000-0000-0000-0000000000b1'), 2, 'every active member is in both');
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id
           where c.audience = 'everyone' and m.user_id = '00000000-0000-0000-0000-0000000000e1'), 2, 'a member who joins later is added too');
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id
           where c.audience = 'everyone' and m.user_id = '00000000-0000-0000-0000-0000000000e2'), 0, 'but a reviewer account is not');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.send_message((select id from public.conversations where system_key = 'announcements'), 'hello')$$, 'P0001', 'Only administrators and teachers can post in this channel.', 'a parent cannot post in Announcements');
select lives_ok($$select public.send_message((select id from public.conversations where system_key = 'general'), 'hello everyone')$$, 'but can post in General');
select throws_ok($$select public.leave_conversation((select id from public.conversations where system_key = 'general'))$$, 'P0001', null, 'and cannot leave a channel for everyone');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.send_message((select id from public.conversations where system_key = 'announcements'), 'Welcome back')$$, 'a teacher can post in Announcements');
reset role;

-- ---- who may create channels ---------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is(public.can_create_channels(), false, 'by default a parent cannot create channels');
select throws_ok($$select public.create_channel('Carpool')$$, 'P0001', 'You are not able to create channels.', 'and is refused if they try');
select throws_ok($$select public.set_channel_creators('members')$$, 'P0001', 'Only an administrator can change this.', 'nor can they change the setting');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.set_channel_creators('staff')$$, 'an administrator can let teachers create channels');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(public.can_create_channels(), true, 'and then a teacher can');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is(public.can_create_channels(), false, 'while a parent still cannot');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.set_channel_creators('members');
reset role;

-- ---- a member creates and runs a channel ------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.create_channel('Carpool', 'Who is driving', 'everyone', 'invite', null, array['00000000-0000-0000-0000-0000000000b2']::uuid[])$$, 'when allowed, a parent can create a channel and invite their household');
select throws_ok($$select public.create_channel('carpool')$$, 'P0001', 'A channel with that name already exists.', 'names are unique, ignoring case');
select throws_ok($$select public.create_channel('Everyone Here', null, 'everyone', 'everyone')$$, 'P0001', 'Only an administrator can make a channel for everyone.', 'only an administrator can make a channel for everyone');
select throws_ok($$select public.add_channel_members((select id from public.conversations where title = 'Carpool'), array['00000000-0000-0000-0000-0000000000b4']::uuid[])$$, 'P0001', 'You can''t message everyone you chose.', 'invites follow the same who-can-message-whom rules');
select lives_ok($$select public.update_channel((select id from public.conversations where title = 'Carpool'), 'Carpools', 'Rides to co-op', 'everyone')$$, 'the creator can rename it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.update_channel((select id from public.conversations where title = 'Carpools'), 'Mine', null, 'everyone')$$, 'P0001', null, 'someone else cannot');
reset role;

-- ---- class links ----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Class One Chat', null, 'everyone', 'invite');
select lives_ok($$select public.set_channel_class((select id from public.conversations where title = 'Class One Chat'), '00000000-0000-0000-0000-0000000000d1')$$, 'an administrator can link a channel to a class');
reset role;
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id
           where c.title = 'Class One Chat' and m.user_id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b3')), 3, 'its members become the class''s teacher and enrolled families');
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id
           where c.title = 'Class One Chat' and m.user_id = '00000000-0000-0000-0000-0000000000b4'), 0, 'and not a family in another class');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Another', null, 'everyone', 'invite');
select throws_ok($$select public.set_channel_class((select id from public.conversations where title = 'Another'), '00000000-0000-0000-0000-0000000000d1')$$, 'P0001', 'That class already has a channel.', 'a class has only one channel');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.set_channel_class((select id from public.conversations where title = 'Carpools'), '00000000-0000-0000-0000-0000000000d2')$$, 'P0001', 'Only an administrator can link a channel to a class.', 'only an administrator can link one');
reset role;

-- ---- news posts in the announcements --------------------------------------------------
insert into public.posts (author_user_id, title, body, audience, published_at)
values ('00000000-0000-0000-0000-0000000000a1', 'Field trip', '<p>Bring <b>boots</b> &amp; a coat.</p>', 'families', now());
select is((select body from public.messages where post_id is not null and conversation_id = (select id from public.conversations where system_key = 'announcements')), E'Field trip\nBring boots & a coat.', 'a published news post appears in Announcements');
insert into public.posts (author_user_id, title, body, audience, class_id, published_at)
values ('00000000-0000-0000-0000-0000000000a2', 'Reading list', 'See attached', 'class', '00000000-0000-0000-0000-0000000000d1', now());
select is((select count(*)::int from public.messages m join public.conversations c on c.id = m.conversation_id where m.post_id is not null and c.title = 'Class One Chat'), 1, 'a class post lands in that class''s channel');
insert into public.posts (author_user_id, title, body, audience, published_at, is_demo)
values ('00000000-0000-0000-0000-0000000000a1', 'Demo news', 'Sample', 'families', now(), true);
select is((select count(*)::int from public.messages where body like 'Demo news%'), 0, 'a reviewer''s sample post does not');
insert into public.posts (author_user_id, title, body, audience) values ('00000000-0000-0000-0000-0000000000a1', 'Draft', 'Not yet', 'families');
select is((select count(*)::int from public.messages where body like 'Draft%'), 0, 'and a draft does not');
update public.posts set published_at = now() where title = 'Draft';
select is((select count(*)::int from public.messages where body like 'Draft%'), 1, 'until it is published');
select is((select count(*)::int from public.notifications where kind = 'message' and body like 'Field trip%'), 0, 'the card does not push again, since the news post already did');

-- ---- archiving ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.archive_channel((select id from public.conversations where title = 'Carpools'), true)$$, 'the creator can archive a channel');
select throws_ok($$select public.send_message((select id from public.conversations where title = 'Carpools'), 'still there?')$$, 'P0001', 'This channel is archived, so it is read-only.', 'an archived channel is read-only');
select ok((select archived_at is not null from public.my_conversations() where title = 'Carpools'), 'and shows as archived in the list');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.archive_channel((select id from public.conversations where system_key = 'general'), true)$$, 'P0001', 'The built-in channels can''t be archived.', 'the built-in channels cannot be archived');
select lives_ok($$select public.archive_channel((select id from public.conversations where title = 'Carpools'), false)$$, 'an administrator can restore an archived channel');
reset role;

select * from finish();
rollback;
