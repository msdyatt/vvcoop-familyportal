-- The class document repository: who reads, adds and removes a class's files.
-- Fixtures: A admin; L1 and L2 lead teachers of the class; S assistant of it;
-- O a teacher of another class. P is a parent with a child enrolled in the class,
-- Q a parent whose child is not. H is a handout, C is curriculum (teachers only).
begin;
select plan(21);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'lead1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'lead2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'assist@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a5', 'other@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'q@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000a3', 'teacher'),
  ('00000000-0000-0000-0000-0000000000a4', 'teacher'),
  ('00000000-0000-0000-0000-0000000000a5', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Pee'), ('00000000-0000-0000-0000-0000000000f2', 'Queue');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'Kid P'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'Kid Q');
insert into public.classes (id, title, grades, active, is_demo) values
  ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true, false),
  ('00000000-0000-0000-0000-0000000000d2', 'Class Two', '{}', true, false);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', 'lead'),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a4', 'assistant'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a5', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c2', 'active');

insert into public.documents (id, class_id, kind, title, storage_path, uploaded_by_user_id) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000000d1', 'handout',    'H', 'handouts/h.pdf', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000000d1', 'curriculum', 'C', 'handouts/c.pdf', '00000000-0000-0000-0000-0000000000a2'),
  -- uploaded by someone who is now only an assistant
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000000d1', 'handout',    'D3', 'handouts/d3.pdf', '00000000-0000-0000-0000-0000000000a4');
-- Two papers that belong to a family, not to a class (the old rule is unchanged for these).
insert into public.documents (id, family_id, kind, title, uploaded_by_user_id) values
  ('00000000-0000-0000-0000-00000000d004', '00000000-0000-0000-0000-0000000000f1', 'letter', 'Family paper one', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000d005', '00000000-0000-0000-0000-0000000000f1', 'letter', 'Family paper two', '00000000-0000-0000-0000-0000000000a2');
insert into storage.objects (bucket_id, name) values
  ('family-village-private', 'handouts/h.pdf'),
  ('family-village-private', 'handouts/c.pdf');

-- ---- a parent of an enrolled child -------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.documents where id = '00000000-0000-0000-0000-00000000d001'), 1::bigint, 'a parent sees the class handout');
select is((select count(*) from public.documents where id = '00000000-0000-0000-0000-00000000d002'), 0::bigint, 'a parent does not see curriculum');
select is((select count(*) from storage.objects where name = 'handouts/h.pdf'), 1::bigint, 'a parent can read the handout file');
select is((select count(*) from storage.objects where name = 'handouts/c.pdf'), 0::bigint, 'a parent cannot read the curriculum file, even knowing its path');
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d001' returning 1) select count(*) from gone), 0::bigint, 'a parent cannot remove a file');
reset role;

-- ---- a parent whose child is in another class ---------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from storage.objects where name = 'handouts/h.pdf'), 0::bigint, 'a parent of another class cannot read its handout file');
select is((select count(*) from public.documents where id = '00000000-0000-0000-0000-00000000d001'), 0::bigint, 'nor see its row');
reset role;

-- ---- a teacher of another class ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.documents where class_id = '00000000-0000-0000-0000-0000000000d1'), 0::bigint, 'a teacher of another class sees none of its files');
select is((select count(*) from storage.objects where name in ('handouts/h.pdf', 'handouts/c.pdf')), 0::bigint, 'nor their stored files');
reset role;

-- ---- the assistant ---------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.documents where id = '00000000-0000-0000-0000-00000000d002'), 1::bigint, 'an assistant sees curriculum');
select is((select count(*) from storage.objects where name = 'handouts/c.pdf'), 1::bigint, 'and can read its file');
select throws_ok($$insert into public.documents (class_id, kind, title, storage_path, uploaded_by_user_id) values ('00000000-0000-0000-0000-0000000000d1', 'handout', 'Nope', 'handouts/nope.pdf', '00000000-0000-0000-0000-0000000000a4')$$, '42501', null, 'an assistant cannot add a file');
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d001' returning 1) select count(*) from gone), 0::bigint, 'an assistant cannot remove a lead''s file');
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d003' returning 1) select count(*) from gone), 0::bigint, 'nor one they uploaded themselves while they led, now they only assist');
reset role;

-- ---- a lead teacher ------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into public.documents (class_id, kind, title, storage_path, uploaded_by_user_id) values ('00000000-0000-0000-0000-0000000000d1', 'handout', 'New', 'handouts/new.pdf', '00000000-0000-0000-0000-0000000000a3')$$, 'a lead teacher can add a file');
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d002' returning 1) select count(*) from gone), 1::bigint, 'a lead can remove a file the other lead uploaded');
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d004' returning 1) select count(*) from gone), 0::bigint, 'but not a family''s paper they did not upload');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d005' returning 1) select count(*) from gone), 1::bigint, 'a paper that is not in a class can still be removed by whoever uploaded it');
reset role;

-- ---- an administrator ------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((with gone as (delete from public.documents where id = '00000000-0000-0000-0000-00000000d001' returning 1) select count(*) from gone), 1::bigint, 'an administrator can remove any file');
reset role;

-- ---- the policies themselves (storage deletes go through the Storage API) -----------------------------------
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'family_documents_handout_lead_delete' and cmd = 'DELETE' and qual like '%leads_class%'), 'a lead teacher may delete the stored file of their class''s document');
select ok((select qual like '%curriculum%' from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'family_documents_handout_read'), 'the file read policy knows about curriculum');

select * from finish();
rollback;
