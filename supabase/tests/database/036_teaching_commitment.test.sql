-- Teaching commitment tracker (migration 20261121090000_teaching_commitment, issue #151).
-- Administrators only (second factor when enrolled, never a reviewer account); counts come from teacher assignments
-- per term through class_terms (no links = all year) and from hall monitor assignments; adjustments and "set" counts
-- with reasons, kept as history and logged; household totals and the handbook check; the import skips blank and zero
-- rows. Every name below is made up.
begin;
select plan(72);

-- ---- fixtures -------------------------------------------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'avery@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'blake@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'casey@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'drew@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) || ' Testwood'
  where email like '%@t.test';
update public.profiles set display_name = 'Casey Sampleford' where email = 'casey@t.test';
update public.profiles set display_name = 'Drew Exampleton' where email = 'drew@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a3', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'), ('00000000-0000-0000-0000-0000000000b4', 'teacher'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin');
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());

-- Two households (Testwood: Avery and Blake; Sampleford: Casey), a teacher with no household (Drew) and a reviewer
-- household that must never show.
insert into public.families (id, display_name, last_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'The Testwood Family', 'Testwood'),
  ('00000000-0000-0000-0000-0000000000f2', 'The Sampleford Family', 'Sampleford'),
  ('00000000-0000-0000-0000-0000000000f9', 'The Reviewer Family', 'Reviewer');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000c1', 'parent');

-- A school year with two terms (one started, one later) and four periods.
update public.school_years set is_current = false;
insert into public.school_years (id, label, starts_on, ends_on, is_current) values
  ('00000000-0000-0000-0000-000000000501', '2090-91', current_date - 30, current_date + 300, true);
insert into public.academic_terms (id, school_year_id, label, starts_on, ends_on, sort_order) values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000501', 'Fall A', current_date - 30, current_date + 20, 1),
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000501', 'Fall B', current_date + 40, current_date + 90, 2);
insert into public.class_blocks (id, school_year_id, label, starts_at, ends_at, sort_order) values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000501', 'History', '10:00', '10:55', 1),
  ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000501', 'Science', '11:00', '11:55', 2),
  ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000501', 'Elective 1', '13:00', '13:55', 3),
  ('00000000-0000-0000-0000-000000000704', '00000000-0000-0000-0000-000000000501', 'Elective 2', '14:00', '14:55', 4);
-- C1 runs all year (no term links); C2 only in Fall A; C3 only in Fall B; C4 is a reviewer class.
insert into public.classes (id, title, school_year_id, block_id, is_demo) values
  ('00000000-0000-0000-0000-000000000801', 'History K-3', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000701', false),
  ('00000000-0000-0000-0000-000000000802', 'Pottery', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000703', false),
  ('00000000-0000-0000-0000-000000000803', 'Chess', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000704', false),
  ('00000000-0000-0000-0000-000000000804', 'Sample class', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000702', true);
insert into public.class_terms (class_id, term_id) values
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000601'),
  ('00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-000000000602');
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-0000000000b1', 'lead'),       -- Avery teaches History all year
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-0000000000b2', 'assistant'),  -- Blake assists History all year
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-0000000000b2', 'assistant'),  -- and Pottery in Fall A
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-0000000000b3', 'lead'),       -- Casey teaches Pottery in Fall A
  ('00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-0000000000b4', 'lead'),       -- Drew teaches Chess in Fall B
  ('00000000-0000-0000-0000-000000000804', '00000000-0000-0000-0000-0000000000b1', 'lead');       -- a reviewer class: never counts

-- ---- who may call what --------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_teaching_commitment(uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_save_commitment_entry(uuid,uuid,text,text,text,integer,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_import_teaching_commitment(uuid,uuid[],jsonb,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_set_hall_monitor(uuid,uuid,uuid,boolean)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_save_commitment_settings(integer,integer,boolean,integer)', 'EXECUTE'),
  'visitors cannot call any of it');
select ok(not has_function_privilege('authenticated', 'private.record_commitment_entry(uuid,uuid,uuid,text,text,text,integer,text,text,text,boolean)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.commitment_cells(uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.save_commitment_note(uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'the inner functions are not callable by members');
select ok(not has_table_privilege('authenticated', 'public.teaching_commitment_entries', 'INSERT')
          and not has_table_privilege('authenticated', 'public.teaching_commitment_entries', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.teaching_commitment_entries', 'DELETE')
          and not has_table_privilege('authenticated', 'public.hall_monitor_assignments', 'INSERT')
          and not has_table_privilege('authenticated', 'public.teaching_commitment_settings', 'UPDATE')
          and not has_table_privilege('anon', 'public.teaching_commitment_entries', 'SELECT'),
  'members cannot write the tables directly, and visitors cannot read them');
select ok((select bool_and(p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('admin_teaching_commitment', 'admin_save_commitment_entry',
             'admin_remove_commitment_entry', 'admin_save_commitment_note', 'admin_save_commitment_settings',
             'admin_set_hall_monitor', 'admin_link_commitment_label', 'admin_import_teaching_commitment')),
  'every admin function is SECURITY DEFINER with an empty search_path');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_teaching_commitment(null)$$, '42501', 'Administrator access is required.',
  'a parent cannot read the tracker');
select throws_ok($$select public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-0000000000b1', null, 'taught', 'adjust', 1, 'Covered a class')$$,
  '42501', 'Administrator access is required.', 'nor adjust a count');
select is((select count(*) from public.teaching_commitment_settings), 0::bigint, 'nor see the settings');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_teaching_commitment(null)$$, '42501', 'Administrator access is required.',
  'a reviewer administrator cannot read it');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_teaching_commitment(null)$$, '42501',
  'Complete two-factor verification before continuing.', 'an administrator who has not used their second factor cannot');
select is((select count(*) from public.teaching_commitment_settings), 0::bigint, 'and the tables stay closed to them');
reset role;

-- ---- counts from assignments ---------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table doc as select public.admin_teaching_commitment(null) as d;
create or replace function pg_temp.cell(p_user text, p_term text, p_role text) returns integer language sql as $$
  select coalesce((select (c ->> 'value')::integer
    from doc, jsonb_array_elements(d -> 'people') p, jsonb_array_elements(p -> 'cells') c
    where p ->> 'key' = '00000000-0000-0000-0000-0000000000' || p_user
      and c ->> 'term_id' = '00000000-0000-0000-0000-000000000' || p_term and c ->> 'role' = p_role), 0); $$;
create or replace function pg_temp.person(p_user text) returns jsonb language sql as $$
  select p from doc, jsonb_array_elements(d -> 'people') p where p ->> 'key' = '00000000-0000-0000-0000-0000000000' || p_user; $$;
create or replace function pg_temp.household(p_id text) returns jsonb language sql as $$
  select h from doc, jsonb_array_elements(d -> 'households') h where h ->> 'id' = '00000000-0000-0000-0000-0000000000' || p_id; $$;
create or replace function pg_temp.hterm(p_id text, p_term text) returns jsonb language sql as $$
  select t from jsonb_array_elements(pg_temp.household(p_id) -> 'terms') t
  where t ->> 'term_id' = '00000000-0000-0000-0000-000000000' || p_term; $$;
create or replace function pg_temp.reload() returns void language sql as $$
  update doc set d = public.admin_teaching_commitment('00000000-0000-0000-0000-000000000501'); $$;

select is((select d -> 'school_year' ->> 'label' from doc), '2090-91', 'with no year chosen, the current year shows');
select is((select jsonb_array_length(d -> 'terms') from doc), 2, 'both terms are columns');
select is(pg_temp.cell('b1', '601', 'taught'), 1, 'a lead teacher of an all-year class has Taught 1 in the first term');
select is(pg_temp.cell('b1', '602', 'taught'), 1, 'and in the second');
select is(pg_temp.cell('b2', '601', 'assisted'), 2, 'two assistant assignments in one term count twice');
select is(pg_temp.cell('b2', '602', 'assisted'), 1, 'a class linked to another term does not count in this one');
select is(pg_temp.cell('b3', '601', 'taught'), 1, 'a class linked to a term counts there');
select is(pg_temp.cell('b3', '602', 'taught'), 0, 'and nowhere else');
select is((pg_temp.person('b1') ->> 'taught')::integer, 2, 'a reviewer class never counts');
select is((pg_temp.person('b4') ->> 'household_id'), null, 'a teacher with no household still has a row');
select is((pg_temp.person('b4') ->> 'total_roles')::integer, 1, 'with their count');
select ok(pg_temp.person('c1') is null, 'reviewer accounts have no row');
select ok(pg_temp.household('f9') is null, 'and the reviewer household is left out');
select is((pg_temp.person('b2') ->> 'blocks_participated')::integer, 2, 'Blocks participated counts terms with any role');
select is((select jsonb_array_length(pg_temp.person('b2') -> 'classes')), 3, 'the classes covered are listed per term');

-- ---- household totals and the handbook check ---------------------------------------------------------------------------
select is((pg_temp.hterm('f1', '601') ->> 'taught')::integer, 1, 'a household''s Taught adds up its adults');
select is((pg_temp.hterm('f1', '601') ->> 'assisted')::integer, 2, 'and so does Assisted');
select is((pg_temp.hterm('f1', '601') ->> 'meets')::boolean, true, 'teach 1 and assist 2 meets the expectation');
select is((pg_temp.hterm('f1', '602') ->> 'meets')::boolean, false, 'assisting once in a term does not');
select is((pg_temp.hterm('f1', '602') ->> 'checked')::boolean, true, 'a later term is checked once anyone has a role in it');
select is((pg_temp.household('f1') ->> 'total_roles')::integer, 5, 'the household total covers the year');
select is((pg_temp.household('f1') ->> 'short_terms')::integer, 1, 'and counts the terms it falls short in');
select is((pg_temp.household('f2') ->> 'meets')::boolean, false, 'a household that teaches but does not assist is short');

-- ---- hall monitors ------------------------------------------------------------------------------------------------------
select lives_ok($$select public.admin_set_hall_monitor('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-0000000000b3', true)$$, 'an administrator assigns a hall monitor');
select lives_ok($$select public.admin_set_hall_monitor('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-000000000704', '00000000-0000-0000-0000-0000000000b3', true)$$, 'for a second period');
select throws_ok($$select public.admin_set_hall_monitor('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-0000000000c1', true)$$, 'P0001',
  'Choose an active member as hall monitor.', 'a reviewer cannot be hall monitor');
select pg_temp.reload();
select is(pg_temp.cell('b3', '601', 'hall_monitor'), 2, 'each period as hall monitor counts');
select is((pg_temp.hterm('f2', '601') ->> 'meets')::boolean, true, 'and counts as assisting by default');
select lives_ok($$select public.admin_save_commitment_settings(1, 2, false, 3)$$, 'an administrator changes the settings');
select pg_temp.reload();
select is((pg_temp.hterm('f2', '601') ->> 'meets')::boolean, false, 'with hall monitoring not counted, the household is short again');
select is((select d -> 'settings' ->> 'heavy_load' from doc), '3', 'the settings come back with the tracker');
select is((pg_temp.person('b3') ->> 'heavy')::boolean, true, 'three roles in a term is carrying a lot at a mark of 3');
select throws_ok($$select public.admin_save_commitment_settings(9, 2, true, 4)$$, 'P0001',
  'Targets are whole numbers from 0 to 8.', 'a target out of range is refused');
select lives_ok($$select public.admin_save_commitment_settings(1, 2, true, 4)$$, 'the defaults go back');
select lives_ok($$select public.admin_set_hall_monitor('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-000000000704', '00000000-0000-0000-0000-0000000000b3', false)$$, 'a hall monitor is taken off');

-- ---- adjustments ------------------------------------------------------------------------------------------------------------
create temp table ids (name text, id uuid);
insert into ids select 'sub', public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000602',
  '00000000-0000-0000-0000-0000000000b2', null, 'assisted', 'adjust', 1, 'Covered Chess for Drew');
select pg_temp.reload();
select is(pg_temp.cell('b2', '602', 'assisted'), 2, 'an adjustment adds to the automatic count');
select is((select (c ->> 'auto')::integer || '/' || (c ->> 'adjust')::integer
           from jsonb_array_elements(pg_temp.person('b2') -> 'cells') c
           where c ->> 'term_id' = '00000000-0000-0000-0000-000000000602' and c ->> 'role' = 'assisted'), '1/1',
  'the cell shows both, so the screen can mark it adjusted');
select is((pg_temp.hterm('f1', '602') ->> 'meets')::boolean, true, 'and the household now meets the expectation');
select throws_ok($$select public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000602',
  '00000000-0000-0000-0000-0000000000b2', null, 'assisted', 'adjust', 1, ' ')$$, 'P0001',
  'Give a reason for the change.', 'an adjustment needs a reason');
select throws_ok($$select public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000602',
  '00000000-0000-0000-0000-0000000000b2', null, 'assisted', 'adjust', 0, 'Nothing')$$, 'P0001', null,
  'an adjustment of zero is refused');
select is((select count(*) from public.audit_log where action = 'teaching_commitment_adjusted'
           and subject_id = (select id::text from ids where name = 'sub')), 1::bigint, 'the adjustment is in the activity log');
insert into ids select 'down', public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000601',
  '00000000-0000-0000-0000-0000000000b1', null, 'taught', 'adjust', -3, 'Absent all block');
select pg_temp.reload();
select is(pg_temp.cell('b1', '601', 'taught'), 0, 'a count never goes below zero');
insert into ids select 'set', public.admin_save_commitment_entry('00000000-0000-0000-0000-000000000602',
  '00000000-0000-0000-0000-0000000000b4', null, 'taught', 'set', 3, 'Taught three electives off the books');
select pg_temp.reload();
select is(pg_temp.cell('b4', '602', 'taught'), 3, 'a set count replaces the automatic one');
select lives_ok($$select public.admin_remove_commitment_entry((select id from ids where name = 'down'), 'Entered by mistake')$$,
  'an administrator removes an entry, with a reason');
select pg_temp.reload();
select is(pg_temp.cell('b1', '601', 'taught'), 1, 'and the count is back');
select is((select removed_reason from public.teaching_commitment_entries where id = (select id from ids where name = 'down')),
  'Entered by mistake', 'the removed entry is kept with its reason');
select throws_ok($$select public.admin_remove_commitment_entry((select id from ids where name = 'down'), 'Again')$$, 'P0001',
  'That entry was already removed.', 'it cannot be removed twice');
reset role;
select throws_ok($$update public.teaching_commitment_entries set amount = 5 where id = (select id from ids where name = 'sub')$$,
  '42501', null, 'even the owner cannot change an entry''s count');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;

-- ---- import -------------------------------------------------------------------------------------------------------------------
create temp table result as select public.admin_import_teaching_commitment('00000000-0000-0000-0000-000000000501',
  array['00000000-0000-0000-0000-000000000601']::uuid[],
  jsonb_build_array(
    -- a matched account
    jsonb_build_object('user_id', '00000000-0000-0000-0000-0000000000b3', 'label', 'Casey Sampleford', 'note', 'Pottery; hall',
      'cells', jsonb_build_array(
        jsonb_build_object('term_id', '00000000-0000-0000-0000-000000000601', 'taught', 2, 'assisted', 1, 'hall_monitor', 0),
        jsonb_build_object('term_id', '00000000-0000-0000-0000-000000000602', 'taught', 4, 'assisted', 0, 'hall_monitor', 0))),
    -- a name with no account, kept as text
    jsonb_build_object('user_id', null, 'label', 'Robin Nobody', 'note', null,
      'cells', jsonb_build_array(
        jsonb_build_object('term_id', '00000000-0000-0000-0000-000000000601', 'taught', 0, 'assisted', 2, 'hall_monitor', 1))),
    -- a blank row
    jsonb_build_object('user_id', null, 'label', '   ', 'cells', jsonb_build_array()),
    -- a zero row
    jsonb_build_object('user_id', null, 'label', 'Zero Person', 'note', 'nothing',
      'cells', jsonb_build_array(
        jsonb_build_object('term_id', '00000000-0000-0000-0000-000000000601', 'taught', 0, 'assisted', 0, 'hall_monitor', 0)))
  ), 'Spreadsheet, Fall A') as r;
select is((select r ->> 'people' from result), '2', 'two people are imported');
select is((select r ->> 'skipped_blank' from result), '1', 'the blank row is skipped');
select is((select r ->> 'skipped_zero' from result), '1', 'and so is the row of zeros');
select is((select r ->> 'entries' from result), '6', 'three counts for each person, for the chosen term only');
select pg_temp.reload();
select is(pg_temp.cell('b3', '601', 'taught'), 2, 'an imported count replaces the automatic one in a chosen term');
select is(pg_temp.cell('b3', '601', 'hall_monitor'), 0, 'an imported zero is a zero, whatever the portal had');
select is(pg_temp.cell('b3', '602', 'taught'), 0, 'a term not chosen is left to the portal');
select is((select p ->> 'total_roles' from doc, jsonb_array_elements(d -> 'people') p where p ->> 'label' = 'Robin Nobody'), '3',
  'a name with no account gets a text-only row');
select is((select count(*) from doc, jsonb_array_elements(d -> 'people') p where p ->> 'name' = 'Zero Person'), 0::bigint,
  'the zero row left nothing behind');
select is(pg_temp.person('b3') ->> 'note', 'Pottery; hall', 'the notes column is kept');
select is((select count(*) from public.audit_log where action = 'teaching_commitment_imported'), 1::bigint,
  'the import is one line in the activity log');
select throws_ok($$select public.admin_import_teaching_commitment('00000000-0000-0000-0000-000000000501',
  array[gen_random_uuid()], '[]'::jsonb, 'x')$$, 'P0001',
  'Choose which terms of this school year the spreadsheet covers.', 'a term from elsewhere is refused');
select lives_ok($$select public.admin_link_commitment_label('00000000-0000-0000-0000-000000000501', 'robin nobody',
  '00000000-0000-0000-0000-0000000000b4')$$, 'a kept name is linked to an account later');
select pg_temp.reload();
select is(pg_temp.cell('b4', '601', 'assisted'), 2, 'and its counts move to that account');

reset role;
select * from finish();
rollback;
