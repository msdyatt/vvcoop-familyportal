-- Start next school year: only administrators, the right things copied, households
-- that are not returning left out, running it twice copies nothing twice, the
-- current year never moves by itself, and the old year is left exactly as it was.
begin;
select plan(65);

-- A1 administrator. P1 (household F1, two active children), P2 (F2), P3 (F3) parents;
-- D a reviewer (demo) parent in F4. T1 an active teacher, T2 a suspended one.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'demo@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 't1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c2', 't2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set status = 'suspended' where email = 't2@t.test';
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'), ('00000000-0000-0000-0000-0000000000b4', 'parent'),
  ('00000000-0000-0000-0000-0000000000c1', 'teacher'), ('00000000-0000-0000-0000-0000000000c2', 'teacher');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'),
  ('00000000-0000-0000-0000-0000000000f3', 'Three'), ('00000000-0000-0000-0000-0000000000f4', 'Demo'),
  ('00000000-0000-0000-0000-0000000000f5', 'Nobody');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b4', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000f1', 'K1b'),
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f2', 'K2'),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000f3', 'K3');

-- 2026-27 is current and fully set up; 2027-28 exists and is empty.
insert into public.school_years (id, label, starts_on, ends_on, is_current) values
  ('00000000-0000-0000-0000-0000000000e1', '2026-27', date '2026-08-01', date '2027-06-30', true),
  ('00000000-0000-0000-0000-0000000000e2', '2027-28', date '2027-08-01', date '2028-06-30', false);
insert into public.rooms (id, name) values ('00000000-0000-0000-0000-0000000000d0', 'Room A');
insert into public.class_blocks (id, school_year_id, label, starts_at, ends_at, sort_order, day_of_week) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'Block 1', time '09:00', time '10:00', 1, 5),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000e1', 'Block 2', time '10:15', time '11:15', 2, 5);
insert into public.academic_terms (id, school_year_id, label, starts_on, ends_on, sort_order) values
  ('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000e1', 'Fall', date '2026-08-31', date '2026-12-18', 1),
  ('00000000-0000-0000-0000-0000000000a8', '00000000-0000-0000-0000-0000000000e1', 'Spring', date '2027-01-11', date '2027-05-21', 2);
insert into public.classes (id, title, description, active, grades, is_elective, capacity, school_year_id, block_id, room_id, is_demo) values
  ('00000000-0000-0000-0000-0000000000c9', 'Art', 'Drawing and paint', true, '{K,1}', false, 12, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d0', false),
  ('00000000-0000-0000-0000-0000000000ca', 'Chess', null, true, '{}', true, null, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b2', null, false),
  ('00000000-0000-0000-0000-0000000000cb', 'Retired class', null, false, '{}', false, null, '00000000-0000-0000-0000-0000000000e1', null, null, false),
  ('00000000-0000-0000-0000-0000000000cc', 'Sample class', null, true, '{}', false, null, '00000000-0000-0000-0000-0000000000e1', null, null, true);
insert into public.class_terms (class_id, term_id) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000a7'),
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000a7'),
  ('00000000-0000-0000-0000-0000000000ca', '00000000-0000-0000-0000-0000000000a8');
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c1', 'lead'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c2', 'assistant');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-00000000aa01', 'active');
insert into public.requirements (id, school_year_id, kind, title, active, amount_per_family, amount_per_child, due_on, payment_url) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'document', 'Handbook', true, null, null, date '2026-09-01', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e1', 'dues', 'Dues', true, 300, 150, date '2026-09-01', 'https://pay.example/dues'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000e1', 'document', 'Retired form', false, null, null, null, null);
insert into public.dues_requirement_options (requirement_id, monthly_enabled, monthly_count, monthly_first_due_on)
values ('00000000-0000-0000-0000-0000000000d2', true, 9, date '2026-09-15');
insert into public.enrollment_periods (id, title, opens_at, closes_at, active, electives_only, school_year_id) values
  ('00000000-0000-0000-0000-0000000000f0', 'Fall classes', timestamptz '2026-04-01 00:00:00+00', timestamptz '2026-04-30 23:59:59+00', true, true, '00000000-0000-0000-0000-0000000000e1');
-- Household One already signed the 2026-27 handbook.
insert into public.family_requirements (requirement_id, family_id, status, signed_at)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'complete', now());

create temp table pv (r jsonb);
create temp table run1 (r jsonb);
create temp table run2 (r jsonb);
create temp table run3 (r jsonb);
create temp table sent (r jsonb);
grant all on pv, run1, run2, run3, sent to public;

-- ---- who can call what -------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_rollover_school_year(uuid,uuid,jsonb,uuid[],jsonb,boolean)', 'EXECUTE'), 'visitors cannot roll a year over');
select ok(not has_function_privilege('anon', 'public.admin_rollover_preview(uuid,uuid,jsonb,uuid[],jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_set_household_returning(uuid,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.admin_rollover_households(uuid)', 'EXECUTE'), 'nor preview it, list households or change an answer');
select ok(not has_table_privilege('authenticated', 'public.household_school_years', 'INSERT')
  and not has_table_privilege('authenticated', 'public.household_school_years', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.household_school_years', 'DELETE'), 'the returning table cannot be written to directly');

-- a parent
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_rollover_school_year('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb, array['00000000-0000-0000-0000-0000000000f1']::uuid[])$$,
  '42501', 'Administrator access is required.', 'a parent cannot roll a year over');
select throws_ok($$select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb, array['00000000-0000-0000-0000-0000000000f1']::uuid[])$$,
  '42501', 'Administrator access is required.', 'nor preview one');
select throws_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1', false)$$,
  '42501', 'Administrator access is required.', 'nor mark a household as not returning');
select throws_ok($$select * from public.admin_rollover_households('00000000-0000-0000-0000-0000000000e2')$$,
  '42501', 'Administrator access is required.', 'nor list the households');
select is((select count(*)::int from public.household_school_years), 0, 'and cannot read the returning table');
reset role;

-- ---- the administrator: the list of households -------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.admin_rollover_households('00000000-0000-0000-0000-0000000000e2')), 3,
  'the list holds the three real households, not the reviewer household or the one with nobody in it');
select is((select children from public.admin_rollover_households('00000000-0000-0000-0000-0000000000e2') where family_id = '00000000-0000-0000-0000-0000000000f1'), 2,
  'with each household''s active children counted');
select is((select count(*)::int from public.admin_rollover_households('00000000-0000-0000-0000-0000000000e2') where status = 'returning' and not decided), 3,
  'and every one counted as returning until someone says otherwise');

-- ---- the preview ----------------------------------------------------------------------------
select throws_ok($$select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e1', '{}'::jsonb, array[]::uuid[])$$,
  'P0001', 'Choose two different school years.', 'a year cannot be copied onto itself');
select throws_ok($$select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb, null)$$,
  'P0001', 'Choose which households are moving forward.', 'the households have to be chosen');
insert into pv select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb,
  array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[]);
select is((select r #>> '{copied,classes}' from pv), '2', 'the preview counts the two active classes (not the retired one or the sample one)');
select is((select r #>> '{households,moving_forward}' from pv) || '/' || (select r #>> '{households,not_returning}' from pv), '2/1', 'and two households moving forward, one not returning');
reset role;
select is((select count(*)::int from public.classes where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.household_school_years)
  + (select count(*)::int from public.dues_charges), 0, 'but the preview wrote nothing at all');

-- ---- the real run --------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run1 select public.admin_rollover_school_year('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb,
  array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[],
  '[{"source_id":"00000000-0000-0000-0000-0000000000a8","starts_on":"2028-01-17","ends_on":"2028-05-26"}]'::jsonb);
reset role;
select is((select r -> 'copied' from run1), (select r -> 'copied' from pv), 'the real run copies exactly what the preview said');
select is((select r #>> '{copied,blocks}' from run1) || ',' || (select r #>> '{copied,terms}' from run1) || ',' || (select r #>> '{copied,classes}' from run1)
  || ',' || (select r #>> '{copied,teacher_assignments}' from run1) || ',' || (select r #>> '{copied,class_terms}' from run1)
  || ',' || (select r #>> '{copied,document_requirements}' from run1) || ',' || (select r #>> '{copied,dues_requirements}' from run1)
  || ',' || (select r #>> '{copied,enrollment_windows}' from run1), '2,2,2,1,3,1,1,1', 'two blocks, two terms, two classes, one teacher, three term links, one document, one dues item, one window');
select is((select count(*)::int from public.classes where school_year_id = '00000000-0000-0000-0000-0000000000e2' and title in ('Art', 'Chess')), 2, 'the new year holds Art and Chess');
select is((select count(*)::int from public.classes where school_year_id = '00000000-0000-0000-0000-0000000000e2' and title in ('Retired class', 'Sample class')), 0, 'but not the retired class or the sample one');
select is((select c.grades || array[c.capacity::text] from public.classes c where c.school_year_id = '00000000-0000-0000-0000-0000000000e2' and c.title = 'Art'), array['K', '1', '12'], 'a class keeps its grades and capacity');
select ok((select b.school_year_id = '00000000-0000-0000-0000-0000000000e2' and b.label = 'Block 1' and c.room_id = '00000000-0000-0000-0000-0000000000d0'
  from public.classes c join public.class_blocks b on b.id = c.block_id
  where c.school_year_id = '00000000-0000-0000-0000-0000000000e2' and c.title = 'Art'), 'and sits in the new year''s copy of its block, in the same room');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e2'), 0, 'no student comes along: families choose again');
select is((select user_id from public.teacher_assignments ta join public.classes c on c.id = ta.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e2'),
  '00000000-0000-0000-0000-0000000000c1'::uuid, 'the active teacher is assigned again and the suspended one is not');
select is((select starts_on from public.academic_terms where school_year_id = '00000000-0000-0000-0000-0000000000e2' and label = 'Fall'), date '2027-08-31', 'term dates move forward a year');
select is((select starts_on from public.academic_terms where school_year_id = '00000000-0000-0000-0000-0000000000e2' and label = 'Spring'), date '2028-01-17', 'unless the administrator typed others');
select is((select due_on from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and kind = 'dues'), date '2027-09-01', 'due dates move forward a year');
select is((select amount_per_family::text || '/' || amount_per_child::text || '/' || payment_url from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and kind = 'dues'),
  '300.00/150.00/https://pay.example/dues', 'with the same amounts and payment link');
select is((select o.monthly_first_due_on from public.dues_requirement_options o join public.requirements r on r.id = o.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2'), date '2027-09-15', 'and the monthly plan choice');
select is((select count(*)::int from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and title = 'Retired form'), 0, 'a requirement that was switched off is not carried over');
select ok((select not active and opens_at = timestamptz '2027-04-01 00:00:00+00' from public.enrollment_periods where school_year_id = '00000000-0000-0000-0000-0000000000e2'),
  'the enrollment window comes over closed, a year later');

-- households
select is((select string_agg(f.display_name || ':' || h.status, ',' order by f.display_name) from public.household_school_years h join public.families f on f.id = h.family_id
  where h.school_year_id = '00000000-0000-0000-0000-0000000000e2'), 'One:returning,Three:not_returning,Two:returning', 'the unticked household is recorded as not returning, the others as returning');
select is((select count(*)::int from public.household_school_years where family_id = '00000000-0000-0000-0000-0000000000f4'), 0, 'the reviewer household is never recorded');
select is((select count(*)::int from public.family_requirements fr join public.requirements r on r.id = fr.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2' and fr.family_id = '00000000-0000-0000-0000-0000000000f1'), 2, 'a returning household is asked for the handbook and charged dues');
select is((select count(*)::int from public.family_requirements fr join public.requirements r on r.id = fr.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2' and fr.family_id = '00000000-0000-0000-0000-0000000000f3'), 0, 'the household that is not returning is asked for nothing');
select is((select string_agg(family_id::text || '=' || amount_due_cents, ',' order by family_id) from public.dues_charges where school_year_id = '00000000-0000-0000-0000-0000000000e2'),
  '00000000-0000-0000-0000-0000000000f1=60000,00000000-0000-0000-0000-0000000000f2=45000', 'dues are charged to the returning households only, by their children');
select is((select status from public.family_requirements fr join public.requirements r on r.id = fr.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2' and r.kind = 'document' and fr.family_id = '00000000-0000-0000-0000-0000000000f1'), 'outstanding', 'last year''s signature does not count toward the new year');
select is((select count(*)::int from public.profiles where status = 'active' and email like '%@t.test'), 6, 'no account was deactivated');
select is((select count(*)::int from public.family_members) + (select count(*)::int from public.children where active), 8, 'and no household member or child was removed');
select is((select count(*)::int from public.invitations), 0, 'and nobody was invited');

-- the current year, and the old year
select is((select label from public.school_years where is_current), '2026-27', 'the current year did not move');
select is((select count(*)::int from public.classes where school_year_id = '00000000-0000-0000-0000-0000000000e1'), 4, 'the old year still has all four of its classes');
select is((select count(*)::int from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e1'), 3, 'and all three requirements');
select is((select count(*)::int from public.enrollments where class_id = '00000000-0000-0000-0000-0000000000c9'), 1, 'and its enrolment');
select is((select count(*)::int from public.household_school_years where school_year_id = '00000000-0000-0000-0000-0000000000e1'), 0, 'every household is still counted for the old year');
select is((select status from public.family_requirements where requirement_id = '00000000-0000-0000-0000-0000000000d1' and family_id = '00000000-0000-0000-0000-0000000000f1'), 'complete', 'and One''s signature on the old handbook still stands');
select is((select count(*)::int from public.audit_log where action = 'school_year_rolled_over' and subject_id = '00000000-0000-0000-0000-0000000000e2'), 1, 'the rollover is written to the activity log');

-- ---- running it twice -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run2 select public.admin_rollover_school_year('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb,
  array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[]);
reset role;
select is((select sum(e.value::integer)::int from run2, jsonb_each_text(run2.r -> 'copied') e), 0, 'a second run copies nothing');
select is((select r #>> '{opened,document_rows}' from run2) || '/' || (select r #>> '{opened,dues_charges}' from run2) || '/' || (select r #>> '{households,changed}' from run2), '0/0/0',
  'opens nothing new and changes no household');
select is((select count(*)::int from public.classes where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.class_blocks where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.enrollment_periods where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.academic_terms where school_year_id = '00000000-0000-0000-0000-0000000000e2')
  + (select count(*)::int from public.dues_charges where school_year_id = '00000000-0000-0000-0000-0000000000e2'), 2 + 2 + 2 + 1 + 2 + 2, 'and the new year holds the same things as before');
select throws_ok($$insert into public.classes (title, school_year_id, copied_from_id) values ('Art again', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c9')$$,
  '23505', null, 'the database itself refuses a second copy of a class in one year');

-- ---- changing a household's answer ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f2', false)$$,
  'a household nothing has happened for can be taken back out');
reset role;
select is((select count(*)::int from public.family_requirements fr join public.requirements r on r.id = fr.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2' and fr.family_id = '00000000-0000-0000-0000-0000000000f2')
  + (select count(*)::int from public.dues_charges where school_year_id = '00000000-0000-0000-0000-0000000000e2' and family_id = '00000000-0000-0000-0000-0000000000f2'), 0,
  'and its untouched requests and charge go with it');
select is((select status from public.household_school_years where family_id = '00000000-0000-0000-0000-0000000000f2' and school_year_id = '00000000-0000-0000-0000-0000000000e2'), 'not_returning', 'recorded as not returning');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f2', true)$$, 'and the answer can be reversed');
select lives_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f3', true)$$, 'including for a household left out the first time');
reset role;
select is((select count(*)::int from public.family_requirements fr join public.requirements r on r.id = fr.requirement_id
  where r.school_year_id = '00000000-0000-0000-0000-0000000000e2' and fr.family_id in ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3')), 4,
  'both are asked for the handbook and charged dues again');
select is((select amount_due_cents from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f3' and school_year_id = '00000000-0000-0000-0000-0000000000e2'), 45000, 'at the amount for their children');

-- a household with paperwork already on file cannot be marked as not returning
update public.family_requirements set status = 'complete', signed_at = now()
where family_id = '00000000-0000-0000-0000-0000000000f1'
  and requirement_id = (select id from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and kind = 'document');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1', false)$$,
  'P0001', null, 'a household that has already signed cannot be marked as not returning');
reset role;
select is((select status from public.household_school_years where family_id = '00000000-0000-0000-0000-0000000000f1' and school_year_id = '00000000-0000-0000-0000-0000000000e2'), 'returning', 'and stays returning');

-- ---- the existing "everyone" actions leave out households that are not returning ----------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f3', false)$$, 'Three is marked as not returning again, for the checks below');
select public.admin_open_dues((select id from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and kind = 'dues'));
reset role;
select is((select count(*)::int from public.dues_charges where family_id = '00000000-0000-0000-0000-0000000000f3' and school_year_id = '00000000-0000-0000-0000-0000000000e2'), 0, 'opening dues for everyone skips the household that is not returning');
select is((select count(*)::int from public.dues_charges where school_year_id = '00000000-0000-0000-0000-0000000000e2'), 2, 'and keeps the others');

insert into storage.objects (bucket_id, name) values ('family-village-private', 'sign/templates/00000000-0000-0000-0000-0000000000d9/original.pdf');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.sign_create_template('00000000-0000-0000-0000-0000000000d9', 'Handbook', 1, repeat('a', 64));
select public.sign_save_fields('00000000-0000-0000-0000-0000000000d9', null, '[{"page":1,"x":0.1,"y":0.8,"w":0.3,"h":0.05,"kind":"signature","slot":1}]'::jsonb);
insert into sent select public.sign_send('00000000-0000-0000-0000-0000000000d9', null,
  (select id from public.requirements where school_year_id = '00000000-0000-0000-0000-0000000000e2' and kind = 'document'));
reset role;
select is((select jsonb_array_length(r -> 'sent') from sent), 1, 'sending the handbook to everyone who owes it reaches one household');
select is((select count(*)::int from public.sign_requests where family_id = '00000000-0000-0000-0000-0000000000f3'), 0, 'and not the one that is not returning');

select * from finish();
rollback;
