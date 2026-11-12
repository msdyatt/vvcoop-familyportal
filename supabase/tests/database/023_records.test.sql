-- Organization records vault: administrators only (with two-factor and never a
-- reviewer account), files are versioned and never overwritten, nothing can be
-- read without the logged open step, records are archived and only erased as a
-- deliberate second step, deleting a person never touches a record, and the
-- sensitive key facts are masked until revealed (which is logged).
begin;
select plan(98);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'admin4@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin'), ('00000000-0000-0000-0000-0000000000a4', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000c1', 'admin');
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());

-- ---- who may call what -----------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_create_record(text,text,text,text,date,date,bigint,text,text[],boolean,date)', 'EXECUTE'), 'visitors cannot add a record');
select ok(not has_function_privilege('anon', 'public.admin_open_record_file(uuid,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_reveal_org_fact(text)', 'EXECUTE'), 'visitors cannot open a file or reveal a fact');
select ok(not has_table_privilege('authenticated', 'public.org_records', 'INSERT')
          and not has_table_privilege('authenticated', 'public.org_records', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.org_records', 'DELETE')
          and not has_table_privilege('authenticated', 'public.org_record_files', 'INSERT')
          and not has_table_privilege('authenticated', 'public.org_record_revisions', 'INSERT'), 'nobody writes the record tables directly');
select ok(not has_table_privilege('authenticated', 'public.org_facts', 'SELECT')
          and not has_table_privilege('authenticated', 'public.org_fact_revisions', 'SELECT')
          and not has_table_privilege('authenticated', 'public.org_record_file_grants', 'SELECT'), 'facts and grants are not readable as tables');

-- ---- a parent and a reviewer account see and do nothing ----------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_create_record('X', 'other', null, null, null, null, null, null, null, null, null)$$, '42501', 'Administrator access is required.', 'a parent cannot add a record');
select throws_ok($$select * from public.admin_list_org_facts()$$, '42501', 'Administrator access is required.', 'a parent cannot read the key facts');
select throws_ok($$select public.admin_reveal_org_fact('ein')$$, '42501', 'Administrator access is required.', 'a parent cannot reveal the EIN');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_create_record('X', 'other', null, null, null, null, null, null, null, null, null)$$, '42501', 'Administrator access is required.', 'a reviewer account cannot add a record even with the admin role');
reset role;

-- ---- an administrator at the wrong assurance level ----------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_create_record('X', 'other', null, null, null, null, null, null, null, null, null)$$, '42501', 'Complete two-factor verification before continuing.', 'an administrator who has not passed the second factor cannot add a record');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok($$select public.admin_create_record('Second factor passed', 'other', null, null, null, null, null, null, null, null, null)$$, 'once they have, they can');
select is((select count(*)::int from public.org_records), 1, 'and read it back');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::int from public.org_records), 0, 'but at the lower level the records table shows nothing');
reset role;

-- ---- adding and changing a record ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table rec as select public.admin_create_record(
  'General liability policy', 'insurance', 'Acme Mutual', 'GL-1234', date '2026-01-01', date '2027-01-01', 125000,
  'Covers the church building', array[' General Liability ', 'general liability', 'Insurance', ''], null, null) as id;
select is((select tags from public.org_records where id = (select id from rec)), array['general liability', 'insurance'], 'tags are trimmed, lower-cased and de-duplicated');
select is((select sensitive from public.org_records where id = (select id from rec)), false, 'an insurance policy is not sensitive by default');
create temp table taxrec as select public.admin_create_record('Form 990 for 2025', 'tax', 'IRS', null, null, null, null, null, null, null, null) as id;
select is((select sensitive from public.org_records where id = (select id from taxrec)), true, 'a tax filing is sensitive by default');
select is((select count(*)::int from public.org_record_revisions where record_id = (select id from rec)), 1, 'adding a record writes its first revision');
select throws_ok($$select public.admin_create_record('  ', 'other', null, null, null, null, null, null, null, null, null)$$, 'P0001', 'Give the record a title.', 'a record needs a title');
select throws_ok($$select public.admin_create_record('X', 'pets', null, null, null, null, null, null, null, null, null)$$, 'P0001', 'Choose a category.', 'a record needs a real category');
select throws_ok($$select public.admin_create_record('X', 'other', null, null, date '2027-01-01', date '2026-01-01', null, null, null, null, null)$$, 'P0001', 'The expiry date is before the effective date.', 'expiry cannot come before the effective date');
select throws_ok($$select public.admin_create_record('X', 'other', null, null, null, null, -5, null, null, null, null)$$, '23514', null, 'an amount cannot be negative');
select is((select count(*)::int from public.audit_log where action = 'record_created' and subject_id = (select id from rec)::text), 1, 'adding a record is in the audit log');

select throws_ok($$select public.admin_update_record((select id from rec), 'General liability policy', 'insurance', 'Acme Mutual', 'GL-1234', date '2026-01-01', date '2028-01-01', 125000, null, '{}', null, null, '')$$, 'P0001', 'Say why you are changing it.', 'a change needs a reason');
select is(public.admin_update_record((select id from rec), 'General liability policy', 'insurance', 'Acme Mutual', 'GL-1234', date '2026-01-01', date '2028-01-01', 130000, 'Renewed for two years', array['insurance'], null, null, 'Renewal came in'), 2, 'a change makes version 2');
select is((select snapshot ->> 'expires_on' from public.org_record_revisions where record_id = (select id from rec) and version = 1), '2027-01-01', 'and the original expiry date is still on record');
select ok((select detail -> 'fields' @> '["expires_on", "amount_cents"]'::jsonb from public.audit_log where action = 'record_updated' and subject_id = (select id from rec)::text), 'the audit log names the fields that changed');
select ok(not exists (select 1 from public.audit_log where action = 'record_updated' and detail::text like '%Acme%'), 'but not their values');
reset role;

select throws_ok($$update public.org_record_revisions set change_note = 'x'$$, '23000', null, 'history is never edited');
select throws_ok($$delete from public.org_records$$, '23000', null, 'a record is never deleted');
select throws_ok($$delete from public.org_record_revisions$$, '23000', null, 'nor its history');

-- ---- files: versions, never overwritten ----------------------------------------------------------
insert into storage.objects (bucket_id, name, owner_id, created_at, metadata)
select 'family-village-private', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f1.pdf', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour', '{"size": 2048, "mimetype": "application/pdf"}'::jsonb
union all
select 'family-village-private', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f2.pdf', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour', '{"size": 4096, "mimetype": "application/pdf"}'::jsonb
union all
select 'family-village-private', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f3.docx', '00000000-0000-0000-0000-0000000000a1', now() - interval '1 hour', '{"size": 10, "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}'::jsonb;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f9', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f9.pdf', 'x.pdf', null, null)$$, 'P0001', 'Upload the file first.', 'a file must be uploaded before it is registered');
select throws_ok($$select public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f1', 'records/elsewhere/00000000-0000-0000-0000-0000000000f1.pdf', 'x.pdf', null, null)$$, '23514', null, 'a file must sit under its own record');
select throws_ok($$select public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f3', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f3.docx', 'x.docx', null, null)$$, '23514', null, 'a Word file is refused by name');
select is(public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f1', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f1.pdf', 'policy-2026.pdf', repeat('a', 64), null), 1, 'the first file is version 1');
select is((select size_bytes from public.org_record_files where version_no = 1 and record_id = (select id from rec)), 2048::bigint, 'its size comes from what storage holds');
select throws_ok($$select public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f2', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f2.pdf', 'policy-2027.pdf', null, '')$$, 'P0001', 'Say what changed in this version.', 'a replacement needs a note');
select is(public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f2', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f2.pdf', 'policy-2027.pdf', null, 'Renewal policy'), 2, 'a replacement is version 2');
select is((select count(*)::int from public.org_record_files where record_id = (select id from rec)), 2, 'and version 1 is still there');
select is((select count(*)::int from public.audit_log where action = 'record_file_added' and subject_id = (select id from rec)::text), 1, 'the upload is in the audit log');
select is((select count(*)::int from public.audit_log where action = 'record_file_replaced' and subject_id = (select id from rec)::text), 1, 'and so is the replacement');
reset role;
select throws_ok($$update public.org_record_files set file_name = 'other.pdf'$$, '23000', null, 'a stored file record cannot be edited');
select throws_ok($$delete from public.org_record_files$$, '23000', null, 'or deleted');

-- ---- reading a file needs the logged open step -----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where name like 'records/%'), 0, 'storage shows an administrator nothing under records/ until they open a file');
select throws_ok($$select public.admin_open_record_file((select id from public.org_record_files where version_no = 1 and record_id = (select id from rec)), 'peek')$$, 'P0001', 'Say whether the file is being viewed or downloaded.', 'an open must say why');
select ok(public.admin_open_record_file((select id from public.org_record_files where version_no = 1 and record_id = (select id from rec)), 'view') like 'records/%/00000000-0000-0000-0000-0000000000f1.pdf', 'opening a file returns its path');
select is((select count(*)::int from storage.objects where name like 'records/%'), 1, 'and makes that one file readable');
select is((select count(*)::int from public.audit_log where action = 'record_file_viewed' and subject_id = (select id from rec)::text), 1, 'the view is in the audit log');
select public.admin_open_record_file((select id from public.org_record_files where version_no = 2 and record_id = (select id from rec)), 'download');
select is((select count(*)::int from public.audit_log where action = 'record_file_downloaded' and subject_id = (select id from rec)::text), 1, 'a download is logged as a download');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where name like 'records/%'), 0, 'another administrator cannot read a file the first one opened');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where name like 'records/%'), 0, 'and a parent cannot');
select is((select count(*)::int from public.org_record_files), 0, 'nor see the file list');
reset role;
update public.org_record_file_grants set expires_at = now() - interval '1 minute';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where name like 'records/%'), 0, 'a grant stops working after two minutes');
reset role;

-- ---- storage rules for uploads, changes and removal -------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('family-village-private', 'records/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000e2.pdf', '00000000-0000-0000-0000-0000000000a1')$$, 'an administrator can upload to the right path');
select is((select count(*)::int from storage.objects where name = 'records/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000e2.pdf'), 1, 'and can read back what they just uploaded');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('family-village-private', 'records/loose.pdf', '00000000-0000-0000-0000-0000000000a1')$$, '42501', null, 'but not to a path of the wrong shape');
select lives_ok($q$do $x$ declare n int; begin update storage.objects set metadata = '{}' where name like 'records/%'; get diagnostics n = row_count; if n <> 0 then raise exception 'changed %', n; end if; end $x$ $q$, 'nobody can change a stored file');
select lives_ok($q$do $x$ declare n int; begin delete from storage.objects where name like 'records/%/00000000-0000-0000-0000-0000000000f%'; get diagnostics n = row_count; if n <> 0 then raise exception 'deleted %', n; end if; end $x$ $q$, 'nobody can delete a file a record points at');
select lives_ok($q$do $x$ declare n int; begin delete from storage.objects where name = 'records/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000e2.pdf'; get diagnostics n = row_count; if n <> 1 then raise exception 'deleted %', n; end if; end $x$ $q$, 'but an upload nothing points at can be cleared away');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id) values ('family-village-private', 'records/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000e3.pdf', '00000000-0000-0000-0000-0000000000b1')$$, '42501', null, 'a parent cannot upload under records/');
reset role;

-- ---- archiving ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_archive_record((select id from rec), '')$$, 'P0001', 'Say why it is being archived.', 'archiving needs a reason');
select lives_ok($$select public.admin_archive_record((select id from rec), 'Policy replaced')$$, 'a record can be archived');
select ok((select archived_at is not null and archive_reason = 'Policy replaced' from public.org_records where id = (select id from rec)), 'and stays, marked archived');
select throws_ok($$select public.admin_archive_record((select id from rec), 'again')$$, 'P0001', 'It is already archived.', 'it cannot be archived twice');
select throws_ok($$select public.admin_update_record((select id from rec), 'x', 'other', null, null, null, null, null, null, '{}', null, null, 'y')$$, 'P0001', 'Restore an archived record before changing it.', 'an archived record cannot be edited');
select throws_ok($$select public.admin_add_record_file((select id from rec), '00000000-0000-0000-0000-0000000000f3', 'records/' || (select id from rec)::text || '/00000000-0000-0000-0000-0000000000f3.docx', 'x', null, 'y')$$, 'P0001', 'Restore an archived record before adding a file.', 'or given a file');
select lives_ok($$select public.admin_open_record_file((select id from public.org_record_files where version_no = 1 and record_id = (select id from rec)), 'view')$$, 'but its files can still be opened');
select lives_ok($$select public.admin_restore_record((select id from rec))$$, 'and it can be restored');
select ok((select archived_at is null and version = 4 from public.org_records where id = (select id from rec)), 'restoring clears the archive and counts as a version');
reset role;

-- ---- erasing is a deliberate second step ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_erase_record((select id from rec), 'General liability policy', 'Not needed')$$, 'P0001', 'Archive the record first. Erasing is a separate step.', 'a record that is not archived cannot be erased');
select public.admin_update_record((select id from taxrec), 'Form 990 for 2025', 'tax', 'IRS', null, null, null, null, null, '{}', null, current_date + 400, 'Keep until the retention date');
select public.admin_archive_record((select id from taxrec), 'Superseded');
select throws_ok($$select public.admin_erase_record((select id from taxrec), 'Form 990 for 2025', 'Cleaning up')$$, 'P0001', null, 'a record inside its retention period cannot be erased');
select public.admin_archive_record((select id from rec), 'Policy replaced');
select throws_ok($$select public.admin_erase_record((select id from rec), 'general liability policy', 'Cleaning up')$$, 'P0001', 'Type the record''s title exactly to confirm.', 'the title has to be typed back exactly');
select throws_ok($$select public.admin_erase_record((select id from rec), 'General liability policy', '')$$, 'P0001', 'Say why it is being erased.', 'and a reason given');
reset role;
-- an administrator who added a record is deleted: the record and history stay
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
create temp table rec2 as select public.admin_create_record('Lease', 'lease', 'Landlord LLC', null, null, null, null, null, null, null, null) as id;
reset role;
insert into storage.objects (bucket_id, name, owner_id, created_at, metadata)
select 'family-village-private', 'records/' || (select id from rec2)::text || '/00000000-0000-0000-0000-0000000000e6.pdf', '00000000-0000-0000-0000-0000000000a2', now() - interval '1 hour', '{"size": 100, "mimetype": "application/pdf"}'::jsonb;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select public.admin_add_record_file((select id from rec2), '00000000-0000-0000-0000-0000000000e6', 'records/' || (select id from rec2)::text || '/00000000-0000-0000-0000-0000000000e6.pdf', 'lease.pdf', null, null);
reset role;
select lives_ok($$delete from auth.users where id = '00000000-0000-0000-0000-0000000000a2'$$, 'an administrator''s sign-in can be deleted despite the records they added');
select is((select count(*)::int from public.org_records where id = (select id from rec2) and created_by is null), 1, 'the record stays, without a name on it');
select is((select count(*)::int from public.org_record_files where record_id = (select id from rec2) and uploaded_by is null), 1, 'and so does its file');
select is((select count(*)::int from public.org_record_revisions where record_id = (select id from rec2) and changed_by is null), 1, 'and its history');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table erased as select public.admin_erase_record((select id from rec), 'General liability policy', 'Replaced and past retention') as r;
select is(jsonb_array_length((select r -> 'storage_paths' from erased)), 2, 'erasing returns the files to clear from storage');
reset role;
select is((select count(*)::int from public.org_records where id = (select id from rec)), 0, 'the record is gone');
select is((select count(*)::int from public.org_record_files where record_id = (select id from rec)) + (select count(*)::int from public.org_record_revisions where record_id = (select id from rec)), 0, 'with its files and history');
select ok(exists (select 1 from public.audit_log where action = 'record_erased' and subject_id = (select id from rec)::text and detail ->> 'title' = 'General liability policy'), 'the audit log keeps who erased what, and why');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($q$do $x$ declare n int; begin delete from storage.objects where name like 'records/' || (select id from rec)::text || '/%'; get diagnostics n = row_count; if n <> 3 then raise exception 'deleted %', n; end if; end $x$ $q$, 'after the erasure its files can be cleared from storage');
reset role;

-- ---- key facts -------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.admin_list_org_facts()), 8, 'the key facts start with the eight the co-op needs');
select is((select sensitive from public.admin_list_org_facts() where key = 'ein'), true, 'the EIN is sensitive');
select throws_ok($$select public.admin_set_org_fact('ein', '12345', 'Entered')$$, 'P0001', 'An EIN looks like 12-3456789.', 'an EIN has to look like one');
select is(public.admin_set_org_fact('ein', '123456789', null), 1, 'the first entry needs no reason');
select is((select value from public.admin_list_org_facts() where key = 'ein'), '••••6789', 'the EIN is masked in the list');
select is(public.admin_reveal_org_fact('ein'), '12-3456789', 'and shown in full, with a dash, when revealed');
select is((select count(*)::int from public.audit_log where action = 'org_fact_revealed' and subject_id = 'ein'), 1, 'revealing it is in the audit log');
select throws_ok($$select public.admin_set_org_fact('ein', '987654321', '')$$, 'P0001', 'Say why you are changing it.', 'a later change needs a reason');
select throws_ok($$select public.admin_set_org_fact('ein', '12-3456789', 'Same')$$, 'P0001', 'Nothing changed.', 'saving the same value is refused');
select is(public.admin_set_org_fact('ein', '98-7654321', 'Corrected a typo'), 2, 'a change makes version 2');
select is((select value from public.admin_org_fact_history('ein') where version = 1), '••••6789', 'the history masks the EIN too');
select is(public.admin_set_org_fact('legal_name', 'Veritas Village', null), 1, 'a plain fact is stored as written');
select is((select value from public.admin_list_org_facts() where key = 'legal_name'), 'Veritas Village', 'and shown as written');
select is(public.admin_reveal_org_fact('legal_name'), 'Veritas Village', 'every reveal is logged, sensitive or not');
select matches(public.admin_add_org_fact('Bank routing note', true), '^custom_[0-9a-f]{12}$', 'a fact of their own can be added');
reset role;
select throws_ok($$update public.org_fact_revisions set value = 'x'$$, '23000', null, 'fact history is never edited');
select throws_ok($$delete from public.org_fact_revisions$$, '23000', null, 'or deleted');
select throws_ok($$delete from public.org_facts$$, '23000', null, 'and a fact is never deleted');

select * from finish();
rollback;
