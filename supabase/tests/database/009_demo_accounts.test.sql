-- Reviewer (demo) accounts: demo and real content must never mix, in either
-- direction, and a demo account can never reach a real person.
begin;
select plan(25);

-- Real: RA administrator, R parent of K in real class RC (taught by RT). Demo: DP, DT.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'rteacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'dparent@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d2', 'dteacher@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'teacher'), ('00000000-0000-0000-0000-0000000000b1', 'parent');
insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'Real');
insert into public.family_members (family_id, user_id, relationship) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent');
insert into public.children (id, family_id, first_name) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K');
insert into public.classes (id, title, grades, active) values ('00000000-0000-0000-0000-0000000000e1', 'Real Class', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'lead');
insert into public.enrollments (class_id, child_id, status) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'active');
insert into public.posts (author_user_id, title, body, audience, published_at) values ('00000000-0000-0000-0000-0000000000a1', 'Real news', 'Real', 'families', now());
insert into public.photos (id, storage_path, thumb_path, visibility, status, uploaded_by)
values ('00000000-0000-0000-0000-0000000000f9', 'library/x/full.jpg', 'library/x/thumb.jpg', 'coop', 'published', '00000000-0000-0000-0000-0000000000a1');

select public.seed_demo_data('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');

-- ---- the seed -------------------------------------------------------------------------
select is((select count(*)::int from public.profiles where is_demo), 2, 'both demo accounts are flagged');
select is((select count(*)::int from public.classes where is_demo), 1, 'one demo class exists');
select is((select count(*)::int from public.children c join public.families f on f.id = c.family_id where f.display_name = 'Demo Family'), 2, 'the demo household has two children');
select is((select count(*)::int from public.conversation_members m join public.conversations c on c.id = m.conversation_id where c.kind = 'class'), 2, 'the class channel holds the demo teacher and parent');

-- ---- a demo parent sees only demo content --------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.posts), 2, 'the demo parent sees the demo news, not the real post');
select is((select count(*)::int from public.classes), 1, 'sees only the demo class');
select is((select count(*)::int from public.photos), 0, 'cannot see a real co-op photo');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'), 0, 'cannot see a real administrator''s profile');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000d2'), 1, 'but can see the demo teacher');
select is((select count(*)::int from public.messageable_people()), 1, 'can message only the demo teacher');
select throws_ok($$select public.start_direct_conversation('00000000-0000-0000-0000-0000000000a1')$$, 'P0001', 'You can''t message that person.', 'cannot message a real administrator');
select ok(public.unread_message_count() >= 2, 'has unread messages waiting, so the app is not empty');
select is((select count(*)::int from public.my_conversations()), 2, 'has a one-to-one conversation and the class channel');
reset role;

-- ---- real members never see demo content -----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.classes), 1, 'a real parent does not see the demo class');
select is((select count(*)::int from public.posts), 1, 'or the demo news');
select is((select count(*)::int from public.profiles where is_demo), 0, 'or the demo people');
select is((select count(*)::int from public.messageable_people() where user_id in ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2')), 0, 'and cannot message them');
reset role;
select ok(not private.can_message('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1'), 'a real parent and the demo parent cannot message each other');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.classes), 2, 'a real administrator can still see the demo class, to clean it up');
reset role;

-- ---- running it again, and removing it ---------------------------------------------------------------
select public.seed_demo_data('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
select is((select count(*)::int from public.classes where is_demo), 1, 'seeding again does not duplicate the demo class');
select is((select count(*)::int from public.families where display_name = 'Demo Family'), 1, 'or the demo household');
select ok(public.remove_demo_data() is not null, 'removing the demo content succeeds');
select is((select count(*)::int from public.classes where is_demo) + (select count(*)::int from public.posts where is_demo), 0, 'and leaves no demo class or posts');
select is((select count(*)::int from public.classes where id = '00000000-0000-0000-0000-0000000000e1'), 1, 'real data is untouched');
select ok(not has_function_privilege('authenticated', 'public.seed_demo_data(uuid,uuid)', 'EXECUTE') and not has_function_privilege('authenticated', 'public.remove_demo_data()', 'EXECUTE'), 'signed-in users cannot run the seed or the removal');

select * from finish();
rollback;
