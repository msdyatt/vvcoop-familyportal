-- Bug bash security fixes (20261122130000_security_quick_wins.sql):
--   #126 an administrator sees and marks read only their own notifications;
--   #163 news post notifications never cross between the demo and real worlds;
--   #166 a reviewer account's photos and albums are demo content and only notify demo approvers;
--   #167 an administrator can save every column Admin, Classes sends, including subject.
-- Fixtures (all fake): A1 a real administrator; P1 a real parent; T1 a real teacher;
-- DT the demo teacher and DP the demo parent (is_demo, @demo.veritasvillage.org).
begin;
select plan(30);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin.one@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent.one@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'teacher.one@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'teacher@demo.veritasvillage.org', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d2', 'parent@demo.veritasvillage.org', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1)
  where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1',
               '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2');
update public.profiles set is_demo = true where email like '%@demo.veritasvillage.org';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000c1', 'teacher'), ('00000000-0000-0000-0000-0000000000d1', 'teacher'),
  ('00000000-0000-0000-0000-0000000000d2', 'parent');
insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'Example');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent');
insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000e0', '2026-27', true);
insert into public.classes (id, title, grades, active, school_year_id) values
  ('00000000-0000-0000-0000-0000000000c9', 'Latin I', '{}', true, '00000000-0000-0000-0000-0000000000e0');

-- ---- #126: notifications belong to their recipient ---------------------------------------------
insert into public.notifications (id, recipient_user_id, kind, title, body) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000b1', 'message', 'admin.one', 'A private message to the parent'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'message', 'parent.one', 'A reply to the admin');

select policies_are('public', 'notifications', array['aal2_required', 'notifications_read', 'notifications_self_update'],
  'notifications_admin_all is gone; only the recipient policies and the two-factor guard remain');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.notifications), 1, 'an administrator reads only their own notification');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'and none of the parent''s, even when asking for them by recipient');
update public.notifications set read_at = now() where id = '00000000-0000-0000-0000-00000000aa01';
update public.notifications set read_at = now() where id in ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02');
select throws_ok($$delete from public.notifications where id = '00000000-0000-0000-0000-00000000aa01'$$, '42501', null,
  'an administrator cannot delete someone else''s notification');
select throws_ok($$insert into public.notifications (recipient_user_id, kind, title) values ('00000000-0000-0000-0000-0000000000b1', 'message', 'Fake')$$, '42501', null,
  'or write one into their bell');
select throws_ok($$update public.notifications set title = 'Edited' where id = '00000000-0000-0000-0000-00000000aa02'$$, 'P0001',
  'A recipient may only mark a notification read.', 'an administrator may only mark their own notification read, like anyone else');
reset role;
select ok((select read_at is null from public.notifications where id = '00000000-0000-0000-0000-00000000aa01'),
  'the administrator''s "mark read" did not touch the parent''s notification');
select ok((select read_at is not null from public.notifications where id = '00000000-0000-0000-0000-00000000aa02'),
  'but did mark their own read');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.notifications), 1, 'the parent still reads their own notification');
reset role;

-- ---- #163: news post notifications stay in their world -------------------------------------------
insert into public.posts (id, author_user_id, title, body, audience, published_at, is_demo) values
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000d1', 'Welcome, reviewers', 'Sample.', 'families', now(), true);
select is((select count(*)::int from public.notifications where subject_id = '00000000-0000-0000-0000-00000000bb01'), 0,
  'a demo post notifies nobody, real or demo');

insert into public.posts (id, author_user_id, title, body, audience, published_at) values
  ('00000000-0000-0000-0000-00000000bb02', '00000000-0000-0000-0000-0000000000a1', 'Picnic Friday', 'Bring a blanket.', 'families', now());
select is((select count(*)::int from public.notifications where subject_id = '00000000-0000-0000-0000-00000000bb02'
  and recipient_user_id in ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1')), 2,
  'a real families post notifies real members');
select is((select count(*)::int from public.notifications n join public.profiles p on p.id = n.recipient_user_id
  where n.subject_id = '00000000-0000-0000-0000-00000000bb02' and p.is_demo), 0, 'but no reviewer account');

insert into public.posts (id, author_user_id, title, body, audience, published_at) values
  ('00000000-0000-0000-0000-00000000bb03', '00000000-0000-0000-0000-0000000000a1', 'Teacher meeting', 'Room 2.', 'teachers', now());
select is((select array_agg(recipient_user_id::text) from public.notifications where subject_id = '00000000-0000-0000-0000-00000000bb03'),
  array['00000000-0000-0000-0000-0000000000c1'], 'a teachers post reaches the real teacher and not the demo teacher');

insert into public.posts (id, author_user_id, title, body, audience, scheduled_for) values
  ('00000000-0000-0000-0000-00000000bb04', '00000000-0000-0000-0000-0000000000d1', 'Later demo post', 'Sample.', 'families', now() + interval '1 day');
update public.posts set is_demo = true where id = '00000000-0000-0000-0000-00000000bb04';
update public.posts set published_at = now(), scheduled_for = null where id = '00000000-0000-0000-0000-00000000bb04';
select is((select count(*)::int from public.notifications where subject_id = '00000000-0000-0000-0000-00000000bb04'), 0,
  'a demo post published later (the scheduled path) notifies nobody either');

-- ---- #166: photos and albums from a reviewer account are demo content -------------------------------
insert into storage.objects (bucket_id, name, owner_id) values
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', '00000000-0000-0000-0000-0000000000d1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', '00000000-0000-0000-0000-0000000000d1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/full.jpg', '00000000-0000-0000-0000-0000000000d2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/thumb.jpg', '00000000-0000-0000-0000-0000000000d2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e3/full.jpg', '00000000-0000-0000-0000-0000000000b1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e3/thumb.jpg', '00000000-0000-0000-0000-0000000000b1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e4/full.jpg', '00000000-0000-0000-0000-0000000000d1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e4/thumb.jpg', '00000000-0000-0000-0000-0000000000d1');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select set_config('t.real_album', public.create_album('Real field day')::text, true);
reset role;
select is((select is_demo from public.photo_albums where id = current_setting('t.real_album')::uuid), false,
  'an album a real administrator creates is real');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
select set_config('t.demo_album', public.create_album('Demo album')::text, true);
select is(public.add_photo('00000000-0000-0000-0000-0000000000e1', 'coop', null, null, 'Demo photo', null, true), 'published',
  'the demo teacher can still publish a co-op photo (inside the demo world)');
select throws_ok(format($$select public.add_photo('00000000-0000-0000-0000-0000000000e4', 'coop', null, %L, null, null, true)$$, current_setting('t.real_album')),
  'P0001', 'That album does not exist.', 'the demo teacher cannot add a photo to a real album');
reset role;
select is((select is_demo from public.photo_albums where id = current_setting('t.demo_album')::uuid), true, 'an album the demo teacher creates is demo content');
select is((select is_demo from public.photos where id = '00000000-0000-0000-0000-0000000000e1'), true, 'and so is the photo they publish');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos where id = '00000000-0000-0000-0000-0000000000e1'), 0, 'a real parent does not see the demo photo');
select is((select count(*)::int from public.photo_albums where id = current_setting('t.demo_album')::uuid), 0, 'or the demo album');
select is(public.add_photo('00000000-0000-0000-0000-0000000000e3', 'coop', null, null, 'From a parent', null, true), 'pending', 'a real parent''s photo waits for approval');
reset role;
select is((select count(*)::int from public.notifications where kind = 'photo_submitted' and subject_id = '00000000-0000-0000-0000-0000000000e3'
  and recipient_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'and the real administrator is asked to approve it');
select is((select is_demo from public.photos where id = '00000000-0000-0000-0000-0000000000e3'), false, 'as real content');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}', true);
set local role authenticated;
select is(public.add_photo('00000000-0000-0000-0000-0000000000e2', 'coop', null, null, 'From the demo parent', null, true), 'pending', 'the demo parent''s photo waits for approval');
reset role;
select is((select count(*)::int from public.notifications where kind = 'photo_submitted' and subject_id = '00000000-0000-0000-0000-0000000000e2'), 0,
  'and no real administrator is told about it');
select is((select is_demo from public.photos where id = '00000000-0000-0000-0000-0000000000e2'), true, 'it is demo content');

-- ---- #167: Admin, Classes can save every column it sends --------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$update public.classes set title = 'Latin I', description = 'Grammar', term = 'Fall', grades = '{3,4}',
    block_id = null, room_id = null, active = true, capacity = 12, is_elective = false, subject = 'History',
    school_year_id = '00000000-0000-0000-0000-0000000000e0'
  where id = '00000000-0000-0000-0000-0000000000c9'$$, 'an administrator can save every column Admin, Classes sends');
reset role;
select is((select subject from public.classes where id = '00000000-0000-0000-0000-0000000000c9'), 'History', 'and the subject is saved');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
update public.classes set subject = 'Science' where id = '00000000-0000-0000-0000-0000000000c9';
reset role;
select is((select subject from public.classes where id = '00000000-0000-0000-0000-0000000000c9'), 'History',
  'a parent still cannot change a class (row-level security refuses the row)');

select * from finish();
rollback;
