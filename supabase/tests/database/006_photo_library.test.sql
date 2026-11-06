-- Photo library: who can add, approve, see, report and remove photos.
begin;
select plan(30);

-- A administrator, T teacher of class C1, P1 parent with a child in C1,
-- P2 parent with a child in C2 only, S a second teacher (teaches C2).
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'teacher2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000a3', 'teacher'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'K2');
insert into public.classes (id, title, grades, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true), ('00000000-0000-0000-0000-0000000000d2', 'Class Two', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a3', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c2', 'active');

-- Uploaded files (the app puts these in storage before registering a photo).
insert into storage.objects (bucket_id, name, owner_id) values
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', '00000000-0000-0000-0000-0000000000a2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', '00000000-0000-0000-0000-0000000000a2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/full.jpg', '00000000-0000-0000-0000-0000000000a2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e2/thumb.jpg', '00000000-0000-0000-0000-0000000000a2'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e3/full.jpg', '00000000-0000-0000-0000-0000000000b1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e3/thumb.jpg', '00000000-0000-0000-0000-0000000000b1');

-- ---- staff publish directly ----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is(public.add_photo('00000000-0000-0000-0000-0000000000e1', 'class', '00000000-0000-0000-0000-0000000000d1', null, 'Pond day', '2026-10-01', true), 'published', 'a teacher publishes a photo to their class straight away');
select is(public.add_photo('00000000-0000-0000-0000-0000000000e2', 'coop', null, null, 'Everyone', null, true), 'published', 'and one to the whole co-op');
select throws_ok($$select public.add_photo('00000000-0000-0000-0000-0000000000e1', 'coop', null, null, 'dup', null, true)$$, 'P0001', 'That photo was already added.', 'the same photo cannot be added twice');
select throws_ok($$select public.add_photo('00000000-0000-0000-0000-0000000000e9', 'coop', null, null, null, null, true)$$, 'P0001', 'The photo files are missing. Please try uploading again.', 'a photo whose files were not uploaded is refused');
select throws_ok($$select public.add_photo('00000000-0000-0000-0000-0000000000e8', 'coop', null, null, null, null, false)$$, 'P0001', 'Please confirm you have permission to share this photo.', 'the uploader must confirm permission');
select throws_ok($$select public.add_photo('00000000-0000-0000-0000-0000000000e7', 'class', '00000000-0000-0000-0000-0000000000d2', null, null, null, true)$$, 'P0001', 'You can only use a class you teach or have a child in.', 'a teacher cannot file photos under another teacher''s class');
select lives_ok($$select public.create_album('Pond day', '00000000-0000-0000-0000-0000000000d1')$$, 'a teacher can create an album for their class');
select throws_ok($$select public.create_album('Nope', '00000000-0000-0000-0000-0000000000d2')$$, 'P0001', 'You can only create albums for classes you teach.', 'but not for a class they do not teach');
reset role;

-- ---- visibility ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 2, 'a parent in the class sees the class photo and the co-op photo');
select throws_ok($$select public.create_album('Mine', null)$$, 'P0001', 'Only teachers and administrators can create albums.', 'parents cannot create albums');
select is(public.add_photo('00000000-0000-0000-0000-0000000000e3', 'class', '00000000-0000-0000-0000-0000000000d1', null, 'From a parent', null, true), 'pending', 'a parent''s photo waits for approval');
select is((select count(*)::int from public.photos where status = 'pending'), 1, 'and the parent can see their own pending photo');
select is((select count(*)::int from storage.objects where name like 'library/00000000-0000-0000-0000-0000000000e1/%'), 2, 'and can open the class photo''s files');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 1, 'a parent outside the class sees only the co-op photo');
select is((select count(*)::int from public.photos where status = 'pending'), 0, 'and no one else''s pending photo');
select is((select count(*)::int from storage.objects where name like 'library/00000000-0000-0000-0000-0000000000e1/%'), 0, 'nor can they open the class photo''s files');
reset role;

-- ---- approval -----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos where status = 'pending'), 0, 'a teacher of a different class cannot see the pending photo');
select throws_ok($$select public.approve_photo('00000000-0000-0000-0000-0000000000e3')$$, 'P0001', 'Only an administrator or a teacher of the class can approve it.', 'or approve it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos where status = 'pending'), 1, 'the class''s teacher sees it');
select lives_ok($$select public.approve_photo('00000000-0000-0000-0000-0000000000e3')$$, 'and can approve it');
reset role;
select is((select count(*)::int from public.notifications where kind = 'photo_approved' and recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 1, 'the parent is told it was added');
select is((select count(*)::int from public.notifications where kind = 'photo_submitted'), 2, 'the teacher and the administrator were told a photo was submitted');

-- ---- reporting and removal ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.report_photo('00000000-0000-0000-0000-0000000000e1', 'not for me')$$, 'P0001', 'You can only report photos you can see.', 'you cannot report a photo you cannot see');
select lives_ok($$select public.report_photo('00000000-0000-0000-0000-0000000000e2', 'My child is in this and we opted out')$$, 'anyone who can see a photo can report it');
select throws_ok($$select * from public.admin_photo_reports()$$, 'P0001', 'Administrator access is required.', 'ordinary members cannot read the reports');
select throws_ok($$select public.delete_photo('00000000-0000-0000-0000-0000000000e2')$$, 'P0001', null, 'a parent cannot remove someone else''s photo');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.admin_photo_reports() where status = 'open'), 1, 'an administrator sees the open report');
select is(array_length(public.resolve_photo_report((select id from public.admin_photo_reports() limit 1), 'remove'), 1), 2, 'removing returns the two files to delete');
reset role;
select is((select count(*)::int from public.photos where id = '00000000-0000-0000-0000-0000000000e2'), 0, 'and the photo is gone');
select ok((select count(*) from public.audit_log where action = 'photo_report_remove') = 1, 'the removal is logged');

select * from finish();
rollback;
