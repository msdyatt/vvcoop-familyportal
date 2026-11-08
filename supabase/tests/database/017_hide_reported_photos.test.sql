-- A photo with an open report is hidden from everyone but administrators until the report is settled.
begin;
select plan(10);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent');

insert into storage.objects (bucket_id, name, owner_id) values
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', '00000000-0000-0000-0000-0000000000b1'),
  ('family-village-private', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', '00000000-0000-0000-0000-0000000000b1');
insert into public.photos (id, storage_path, thumb_path, caption, visibility, status, uploaded_by, approved_by, approved_at)
values ('00000000-0000-0000-0000-0000000000e1', 'library/00000000-0000-0000-0000-0000000000e1/full.jpg', 'library/00000000-0000-0000-0000-0000000000e1/thumb.jpg', 'Field day', 'coop', 'published', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', now());

-- ---- before any report
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 1, 'a member sees a published co-op photo');
select is((select count(*)::int from storage.objects where name like 'library/00000000-0000-0000-0000-0000000000e1/%'), 2, 'and can read its files');
reset role;
-- ---- reporting hides it
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.report_photo('00000000-0000-0000-0000-0000000000e1', 'Not appropriate')$$, 'a member can report it');
select is((select count(*)::int from public.photos), 0, 'and it is hidden from the person who reported it');
select is((select count(*)::int from storage.objects where name like 'library/00000000-0000-0000-0000-0000000000e1/%'), 0, 'its files stop being readable too');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 0, 'it is hidden from the uploader as well');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 1, 'but an administrator can still see it to review it');
select set_config('test.report', (select id::text from public.photo_reports limit 1), true);
select lives_ok($$select public.resolve_photo_report(current_setting('test.report')::uuid, 'dismiss')$$, 'the administrator dismisses the report');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 1, 'and the photo is back in the library');
reset role;
-- ---- two reports: it stays hidden until both are settled
delete from public.photo_reports;
insert into public.photo_reports (photo_id, reporter_id, reason) values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'one'), ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b2', 'two');
update public.photo_reports set status = 'dismissed' where reason = 'one';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.photos), 0, 'one report still open keeps it hidden');
reset role;
select * from finish();
rollback;
