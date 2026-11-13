-- The #Announcements card follows its news post: edits, a different audience, unpublishing and deleting.
-- Fixtures: A administrator, P1 a parent whose child is in class C1, a channel linked to C1.
-- "now()" is fixed inside a test transaction, so timestamps that must differ are set by hand first.
begin;
select plan(30);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p3@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b4', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f3', 'Three');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b4', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'K3');
insert into public.classes (id, title, grades, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true),
  ('00000000-0000-0000-0000-0000000000d2', 'Class Two', '{}', true);
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c3', 'active');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.create_channel('Class One Chat', null, 'everyone', 'invite');
select public.set_channel_class((select id from public.conversations where title = 'Class One Chat'), '00000000-0000-0000-0000-0000000000d1');
reset role;

-- ---- publishing makes one card -------------------------------------------------------------------
insert into public.posts (id, author_user_id, title, body, audience, published_at)
values ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'Field trip', '<p>Bring boots.</p>', 'families', now());
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1, 'publishing a post makes one card');
select is((select conversation_id from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
          (select id from public.conversations where system_key = 'announcements'), 'in #Announcements');
select set_config('test.card', (select id::text from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000001'), true);
select set_config('test.notices', (select count(*)::text from public.notifications where subject_id = 'aaaaaaaa-0000-0000-0000-000000000001'), true);
insert into public.message_reactions (message_id, user_id, emoji) values (current_setting('test.card')::uuid, '00000000-0000-0000-0000-0000000000b1', '👍');
update public.conversations set last_message_at = '2020-01-01' where system_key = 'announcements';

-- ---- edits flow to the card --------------------------------------------------------------------
update public.posts set body = '<p>Bring boots and <b>sunscreen</b>.</p>' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select body from public.messages where id = current_setting('test.card')::uuid), E'Field trip\nBring boots and sunscreen.', 'editing the text updates the card');
select ok((select edited_at is not null from public.messages where id = current_setting('test.card')::uuid), 'and marks it Edited');
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1, 'it is still one card');
select is((select count(*)::int from public.message_reactions where message_id = current_setting('test.card')::uuid), 1, 'its reactions stay, because it is the same message');
select is((select last_message_at::date from public.conversations where system_key = 'announcements'), '2020-01-01'::date, 'an edit does not bump the channel');

update public.posts set title = 'Field trip (moved)' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select split_part(body, E'\n', 1) from public.messages where id = current_setting('test.card')::uuid), 'Field trip (moved)', 'editing the headline updates the card');

update public.messages set edited_at = '2020-01-01' where id = current_setting('test.card')::uuid;
update public.posts set title = title where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select edited_at::date from public.messages where id = current_setting('test.card')::uuid), '2020-01-01'::date, 'saving with nothing changed does not mark it Edited again');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select body from public.messages where id = current_setting('test.card')::uuid), E'Field trip (moved)\nBring boots and sunscreen.', 'a family member reading the channel sees the edited text');
reset role;

-- ---- public site or every family: same channel, same card ---------------------------------------
update public.posts set audience = 'public' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select count(*)::int from public.messages where id = current_setting('test.card')::uuid and post_id = 'aaaaaaaa-0000-0000-0000-000000000001' and deleted_at is null), 1, 'switching to the public site keeps the same card');
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1, 'and makes no second one');
select is((select count(*)::text from public.notifications where subject_id = 'aaaaaaaa-0000-0000-0000-000000000001'), current_setting('test.notices'), 'none of these edits notified anyone');

-- ---- a different channel ---------------------------------------------------------------------------
insert into public.posts (id, author_user_id, title, body, audience, class_id, published_at)
values ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'Reading list', 'See attached', 'class', '00000000-0000-0000-0000-0000000000d1', now());
select is((select c.title from public.messages m join public.conversations c on c.id = m.conversation_id where m.post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'Class One Chat', 'a class post lands in the class channel');
select set_config('test.card2', (select id::text from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), true);
insert into public.message_reactions (message_id, user_id, emoji) values (current_setting('test.card2')::uuid, '00000000-0000-0000-0000-0000000000b1', '❤️');

update public.posts set audience = 'families', class_id = null where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select ok((select deleted_at is not null and post_id is null and body is null from public.messages where id = current_setting('test.card2')::uuid), 'moving a post to every family retires its card in the class channel');
select is((select c.system_key from public.messages m join public.conversations c on c.id = m.conversation_id where m.post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), 'announcements', 'and puts a new one in #Announcements');
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), 1, 'only one');
select is((select count(*)::int from public.message_reactions where message_id = current_setting('test.card2')::uuid), 0, 'the old card''s reactions are cleared');

-- ---- teaching team only has no channel; unpublishing takes the card away ---------------------
update public.posts set audience = 'teachers' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), 0, 'a teaching-team-only post has no card');
update public.posts set audience = 'families' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002' and deleted_at is null), 1, 'and gets one when it is opened to families');
update public.posts set published_at = null where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002'), 0, 'an unpublished post has no card');
update public.posts set published_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000002' and deleted_at is null), 1, 'and gets it back when published again');
select is((select count(*)::int from public.notifications where kind = 'message'), 0, 'no card ever pushed a message notice');

-- ---- deleting the post -------------------------------------------------------------------------
delete from public.posts where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select ok((select deleted_at is not null and post_id is null and body is null from public.messages where id = current_setting('test.card')::uuid), 'deleting the post turns its card into a removed message');
select is((select count(*)::int from public.messages where body like 'Field trip%' and deleted_at is null), 0, 'and leaves no ordinary message with the old headline');
select is((select count(*)::int from public.message_reactions where message_id = current_setting('test.card')::uuid), 0, 'its reactions are cleared');

-- ---- a card removed on a report stays removed ------------------------------------------------------
insert into public.posts (id, author_user_id, title, body, audience, published_at)
values ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'Reported', '<p>Original</p>', 'families', now());
update public.messages set body = null, deleted_at = now() where post_id = 'aaaaaaaa-0000-0000-0000-000000000003';
update public.posts set body = '<p>Changed</p>' where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select ok((select body is null and deleted_at is not null from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000003'), 'an edit does not bring back a card an administrator removed');
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000003'), 1, 'nor make a second one');
select throws_ok($$insert into public.messages (conversation_id, sender_id, body, post_id)
  values ((select id from public.conversations where system_key = 'announcements'), '00000000-0000-0000-0000-0000000000a1', 'again', 'aaaaaaaa-0000-0000-0000-000000000003')$$,
  '23505', null, 'a post can have only one card');

-- ---- a reviewer''s sample post has none ---------------------------------------------------------------
insert into public.posts (id, author_user_id, title, body, audience, published_at)
values ('aaaaaaaa-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'Sample', 'x', 'families', now());
update public.posts set is_demo = true where id = 'aaaaaaaa-0000-0000-0000-000000000004';
select is((select count(*)::int from public.messages where post_id = 'aaaaaaaa-0000-0000-0000-000000000004'), 0, 'a post turned into a reviewer sample loses its card');

select * from finish();
rollback;
