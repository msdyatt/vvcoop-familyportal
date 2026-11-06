-- Erasing a person's data: what goes, what stays without their name, and the
-- guards (the last administrator cannot leave; only the service role may call it).
begin;
select plan(25);

-- A1 the only administrator, T a teacher of C1, P1 and P1b adults of household F1,
-- P2 sole adult of F2, P3 sole adult of F3 (with a child and a document).
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p1b@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p3@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'), ('00000000-0000-0000-0000-0000000000b4', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'), ('00000000-0000-0000-0000-0000000000f3', 'Three');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b4', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'K3');
insert into public.classes (id, title, grades, active) values ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'lead');
insert into public.enrollments (class_id, child_id, status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active');
insert into public.documents (family_id, kind, title, storage_path) values ('00000000-0000-0000-0000-0000000000f3', 'form', 'Waiver', 'documents/d.pdf');

-- The teacher's footprint.
insert into public.teacher_notes (child_id, class_id, author_user_id, body) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', 'Good week');
insert into public.posts (author_user_id, title, body, audience) values ('00000000-0000-0000-0000-0000000000a2', 'Hello', 'News', 'families');
insert into public.print_requests (requested_by_user_id, title, storage_path) values ('00000000-0000-0000-0000-0000000000a2', 'Handout', 'handouts/x.pdf');
insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail) values
  ('00000000-0000-0000-0000-0000000000a2', 'note_added', 'child', 'c1', '{}'),
  ('00000000-0000-0000-0000-0000000000a1', 'family_adult_invited', 'family', 'f1', '{"email":"teacher@t.test","family_name":"One"}');
insert into public.invitations (email, invited_by_user_id, token_hash, expires_at) values ('teacher@t.test', '00000000-0000-0000-0000-0000000000a1', 'h1', now() + interval '1 day');
insert into public.email_outbox (recipient_email, subject, html_body) values ('teacher@t.test', 'Welcome', '<p>hi</p>');
insert into public.conversations (id, kind, created_by) values ('00000000-0000-0000-0000-0000000000e1', 'direct', '00000000-0000-0000-0000-0000000000a2');
insert into public.conversation_members (conversation_id, user_id) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1');
insert into public.messages (id, conversation_id, sender_id, body, image_path) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'From the teacher', 'messages/00000000-0000-0000-0000-0000000000e1/t.jpg'),
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'From the parent', null);

-- ---- who may call it ------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.erase_account_data(uuid,boolean)', 'EXECUTE') and not has_function_privilege('anon', 'public.erase_account_data(uuid,boolean)', 'EXECUTE'), 'signed-in users and visitors cannot call the erase function');
select ok(has_function_privilege('service_role', 'public.erase_account_data(uuid,boolean)', 'EXECUTE'), 'the service role can');

-- ---- the last administrator -------------------------------------------------------------
select throws_ok($$select public.erase_account_data('00000000-0000-0000-0000-0000000000a1')$$, 'P0001', 'last_admin', 'the only administrator cannot be erased');

-- ---- a teacher ---------------------------------------------------------------------------
create temp table result as select public.erase_account_data('00000000-0000-0000-0000-0000000000a2') as r;
select is((select r ->> 'email' from result), 'teacher@t.test', 'the email is returned so a confirmation can be sent');
select ok((select r -> 'storage_paths' ? 'messages/00000000-0000-0000-0000-0000000000e1/t.jpg' from result), 'the photo they sent is queued for deletion');
select ok((select r -> 'storage_paths' ? 'handouts/x.pdf' from result), 'and their print-request file');
select ok((select body is null and image_path is null and deleted_at is not null from public.messages where id = '00000000-0000-0000-0000-0000000000f9'), 'their messages are erased');
select is((select body from public.messages where id = '00000000-0000-0000-0000-0000000000fa'), 'From the parent', 'but the other person''s messages stay');
select is((select count(*)::int from public.invitations where email = 'teacher@t.test'), 0, 'invitations to their email are gone');
select is((select count(*)::int from public.email_outbox where recipient_email = 'teacher@t.test'), 0, 'and the emails logged to them');
select is((select detail ? 'email' from public.audit_log where action = 'family_adult_invited'), false, 'and their email is scrubbed from the activity log');
select is((select count(*)::int from public.notifications where kind = 'account_deleted' and recipient_user_id = '00000000-0000-0000-0000-0000000000a1' and body like '%Class One%'), 1, 'administrators are told, including which class they taught');

select lives_ok($$delete from auth.users where id = '00000000-0000-0000-0000-0000000000a2'$$, 'the sign-in can now be deleted despite the notes, posts and log entries they wrote');
select is((select author_user_id from public.teacher_notes where body = 'Good week'), null, 'their notes stay, without their name');
select is((select count(*)::int from public.posts where title = 'Hello' and author_user_id is null), 1, 'so do their news posts');
select is((select actor_user_id from public.audit_log where action = 'note_added'), null, 'and their entries in the activity log');
select is((select count(*)::int from public.print_requests where title = 'Handout'), 0, 'their print requests go with them');
select is((select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000000a2'), 0, 'and the profile is gone');

-- ---- households ------------------------------------------------------------------------------
create temp table household_kept as select public.erase_account_data('00000000-0000-0000-0000-0000000000b3') as r;
select is((select r -> 'households_without_adults' ->> 0 from household_kept), 'Two', 'a sole adult leaving a household is reported');
select is((select count(*)::int from public.families where id = '00000000-0000-0000-0000-0000000000f2'), 1, 'and by default the household is kept for an administrator to close out');
create temp table other_adult as select public.erase_account_data('00000000-0000-0000-0000-0000000000b2') as r;
select is((select jsonb_array_length(r -> 'households_without_adults') from other_adult), 0, 'a household that still has another adult is untouched');
create temp table household_gone as select public.erase_account_data('00000000-0000-0000-0000-0000000000b4', true) as r;
select is((select r -> 'households_deleted' ->> 0 from household_gone), 'Three', 'a sole adult can delete their household too');
select is((select count(*)::int from public.children where id = '00000000-0000-0000-0000-0000000000c3'), 0, 'taking its children with it');
select ok((select r -> 'storage_paths' ? 'documents/d.pdf' from household_gone), 'and queuing its documents for deletion');

-- ---- an administrator can leave once another exists ------------------------------------------------
insert into auth.users (id, email, aud, role) values ('00000000-0000-0000-0000-0000000000a9', 'admin2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email = 'admin2@t.test';
insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000a9', 'admin');
select lives_ok($$select public.erase_account_data('00000000-0000-0000-0000-0000000000a1')$$, 'with a second administrator in place, the first can be erased');

select * from finish();
rollback;
