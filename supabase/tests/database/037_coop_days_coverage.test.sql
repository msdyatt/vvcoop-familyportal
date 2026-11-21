-- Co-op days, absences, covers and points (migration 20261121100000_coop_days_coverage, issue #151 with #129).
-- Shifts are assumed worked; "I can't make it" releases them; others claim them or log covers afterwards; a household
-- that is not there is not expected that day; points and balances follow. Every name below is made up.
begin;
select plan(50);

-- ---- fixtures -------------------------------------------------------------------------------------------------------
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'avery@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'blake@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'casey@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'drew@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) || ' Testwood' where email like '%@t.test';
update public.profiles set display_name = 'Casey Sampleford' where email = 'casey@t.test';
update public.profiles set display_name = 'Drew Exampleton' where email = 'drew@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b2', 'parent'), ('00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000b4', 'teacher'), ('00000000-0000-0000-0000-0000000000c1', 'parent');
insert into public.families (id, display_name, last_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'The Testwood Family', 'Testwood'),
  ('00000000-0000-0000-0000-0000000000f2', 'The Sampleford Family', 'Sampleford');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'parent');

update public.school_years set is_current = false;
insert into public.school_years (id, label, starts_on, ends_on, is_current) values
  ('00000000-0000-0000-0000-000000000501', '2090-91', private.coop_today() - 60, private.coop_today() + 300, true);
insert into public.academic_terms (id, school_year_id, label, starts_on, ends_on, sort_order) values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000501', 'Block 1', private.coop_today() - 30, private.coop_today() + 30, 1),
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000501', 'Block 2', private.coop_today() + 40, private.coop_today() + 90, 2);
insert into public.class_blocks (id, school_year_id, label, starts_at, ends_at, sort_order, day_of_week) values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000501', 'History', '10:00', '10:55', 1, 5),
  ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000501', 'Science', '11:00', '11:55', 2, 5),
  ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000501', 'Elective 1', '13:00', '13:55', 3, 5);
insert into public.classes (id, title, school_year_id, block_id) values
  ('00000000-0000-0000-0000-000000000801', 'History K-3', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000802', 'Pottery', '00000000-0000-0000-0000-000000000501', '00000000-0000-0000-0000-000000000703');
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-0000000000b1', 'lead'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-0000000000b2', 'assistant'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-0000000000b3', 'assistant'),
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-0000000000b3', 'lead');
insert into public.hall_monitor_assignments (term_id, block_id, user_id) values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-0000000000b4');

create or replace function pg_temp.as_user(p text) returns void language sql as $$
  select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000' || p || '","role":"authenticated"}', true); $$;
create or replace function pg_temp.day(p_offset integer) returns uuid language sql security definer as $$
  select id from public.coop_days where day = private.coop_today() + p_offset; $$;

-- ---- who may call what -------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.my_coop_days()', 'EXECUTE')
          and not has_function_privilege('anon', 'public.cover_coop_shift(uuid,text,uuid,uuid,uuid,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.admin_commitment_days(uuid)', 'EXECUTE'), 'visitors cannot call any of it');
select ok(not has_function_privilege('authenticated', 'private.record_coop_cover(uuid,uuid,text,uuid,uuid,uuid,uuid,text,boolean)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.set_coop_absence(uuid,uuid,uuid,uuid,boolean,text,boolean)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.commitment_points(uuid)', 'EXECUTE'), 'the inner functions are closed to members');
select ok(not has_table_privilege('authenticated', 'public.coop_day_covers', 'INSERT')
          and not has_table_privilege('authenticated', 'public.coop_day_absences', 'DELETE')
          and not has_table_privilege('authenticated', 'public.coop_days', 'UPDATE'), 'members cannot write the tables directly');

-- ---- co-op days (admin) ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('b1');
set local role authenticated;
select throws_ok($$select public.admin_set_coop_day('00000000-0000-0000-0000-000000000601', private.coop_today(), 'add', null)$$,
  '42501', 'Administrator access is required.', 'a parent cannot add co-op days');
select throws_ok($$select public.admin_commitment_days(null)$$, '42501', 'Administrator access is required.', 'nor read the points');
reset role;

select pg_temp.as_user('a1');
set local role authenticated;
select is(public.admin_generate_coop_days('00000000-0000-0000-0000-000000000602'),
  (select count(*)::integer from generate_series(private.coop_today() + 40, private.coop_today() + 90, interval '1 day') d
   where extract(dow from d) = 5), 'a term is filled with its Fridays (the weekday of its periods)');
select is(public.admin_generate_coop_days('00000000-0000-0000-0000-000000000602'), 0, 'filling it again adds nothing');
select lives_ok($$select public.admin_set_coop_day('00000000-0000-0000-0000-000000000601', private.coop_today() + o, 'add', null)
                  from unnest(array[-21, -14, -7, 7, -28]) o$$, 'an administrator adds dates one by one');
select lives_ok($$select public.admin_set_coop_day('00000000-0000-0000-0000-000000000601', private.coop_today() - 28, 'cancel', 'Holiday')$$,
  'and cancels a holiday');
select throws_ok($$select public.admin_set_coop_day('00000000-0000-0000-0000-000000000601', private.coop_today() + 200, 'add', null)$$,
  'P0001', 'Choose a date within the term.', 'a date outside the term is refused');

-- ---- absences and covers ------------------------------------------------------------------------------------------------------
-- Day -21: Avery is out; Drew covers Avery's History.
select lives_ok($$select public.admin_set_coop_absence(pg_temp.day(-21), null, '00000000-0000-0000-0000-0000000000b1', true, 'Sick')$$,
  'an administrator records a past absence');
select ok(public.admin_record_coop_cover(pg_temp.day(-21), 'taught', '00000000-0000-0000-0000-000000000801', null,
  '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b4', null) is not null, 'and who covered it');
-- Day -14: the Sampleford household is not there.
select lives_ok($$select public.admin_set_coop_absence(pg_temp.day(-14), '00000000-0000-0000-0000-0000000000f2', null, true, null)$$,
  'a whole household can be out');
select throws_ok($$select public.admin_set_coop_day('00000000-0000-0000-0000-000000000601', private.coop_today() - 14, 'remove', null)$$,
  'P0001', 'Absences or covers are recorded for that day; cancel it instead.', 'a day with records cannot be removed');
reset role;

-- Day -7: Blake does not come and says nothing; Drew logs that he covered.
select pg_temp.as_user('b4');
set local role authenticated;
create temp table mine as select public.my_coop_days() as d;
select is((select string_agg(((dd ->> 'day')::date - private.coop_today())::text, ',' order by (dd ->> 'day')::date)
           from mine, jsonb_array_elements(d -> 'days') dd where (dd ->> 'day')::date <= private.coop_today() + 30), '-14,-7,7',
  'a member sees the co-op days from two weeks back onwards');
select ok((select bool_or(x ->> 'title' = 'History K-3' and x ->> 'owner_id' = '00000000-0000-0000-0000-0000000000b2')
           from mine, jsonb_array_elements(d -> 'days') dd, jsonb_array_elements(dd -> 'loggable') x
           where (dd ->> 'day')::date = private.coop_today() - 7), 'on a past day, others'' shifts can be logged as covered');
select ok(public.cover_coop_shift(pg_temp.day(-7), 'assisted', '00000000-0000-0000-0000-000000000801', null,
  '00000000-0000-0000-0000-0000000000b2', 'Blake did not come') is not null, 'a member logs covering for someone who did not come');
select throws_ok($$select public.cover_coop_shift(pg_temp.day(-7), 'assisted', '00000000-0000-0000-0000-000000000801', null,
  '00000000-0000-0000-0000-0000000000b2', null)$$, 'P0001', 'Someone is already covering that shift.', 'a shift is covered once');
select throws_ok($$select public.cover_coop_shift(pg_temp.day(7), 'taught', '00000000-0000-0000-0000-000000000802', null,
  '00000000-0000-0000-0000-0000000000b3', null)$$, 'P0001', 'That shift has not been released.',
  'before the day, a shift that was not released cannot be taken');
select throws_ok($$select public.cover_coop_shift(pg_temp.day(7), 'hall_monitor', null, '00000000-0000-0000-0000-000000000702',
  '00000000-0000-0000-0000-0000000000b4', null)$$, 'P0001', 'That is already their own shift.', 'nor one''s own');
select is((select count(*) from public.coop_day_covers), 0::bigint, 'members cannot read the covers table');
reset role;

-- Day +7: Blake can't make it. Two adults are still in History, so the shift is optional.
select pg_temp.as_user('b2');
set local role authenticated;
select lives_ok($$select public.set_my_coop_day_absence(pg_temp.day(7), 'me', true, 'Away')$$, 'a member says they can''t make it');
select throws_ok($$select public.set_my_coop_day_absence(pg_temp.day(-7), 'me', true, null)$$, 'P0001',
  'That day has passed. Ask an administrator to change it.', 'but not for a day that has passed');
reset role;
select pg_temp.as_user('b3');
set local role authenticated;
select is((select x ->> 'needed' from jsonb_array_elements(public.my_coop_days() -> 'days') dd, jsonb_array_elements(dd -> 'open') x
           where (dd ->> 'day')::date = private.coop_today() + 7 and x ->> 'role' = 'assisted'), 'false',
  'an assistant''s released shift in a class that keeps two adults is optional');
reset role;
select pg_temp.as_user('b1');
set local role authenticated;
select lives_ok($$select public.set_my_coop_day_absence(pg_temp.day(7), 'me', true, null)$$, 'the lead teacher can''t make it either');
select is((select string_agg(x ->> 'role' || ':' || (x ->> 'needed'), ',' order by x ->> 'role')
           from jsonb_array_elements(public.my_coop_days() -> 'days') dd, jsonb_array_elements(dd -> 'open') x
           where (dd ->> 'day')::date = private.coop_today() + 7), 'assisted:true',
  'now the assistant''s shift is needed (a person does not see their own released shift)');
reset role;
select pg_temp.as_user('b3');
set local role authenticated;
select ok(public.cover_coop_shift(pg_temp.day(7), 'taught', '00000000-0000-0000-0000-000000000801', null,
  '00000000-0000-0000-0000-0000000000b1', null) is not null, 'another member takes the released lead shift');
reset role;
select pg_temp.as_user('b1');
set local role authenticated;
select is((select x ->> 'covering_name' from jsonb_array_elements(public.my_coop_days() -> 'days') dd, jsonb_array_elements(dd -> 'mine') x
           where (dd ->> 'day')::date = private.coop_today() + 7), 'Casey Sampleford', 'the absent teacher sees who is covering');
select throws_ok($$select public.set_my_coop_day_absence(pg_temp.day(7), 'me', false, null)$$, 'P0001',
  'Someone is already covering one of these shifts. Ask them, or an administrator, to change it.',
  'an absence cannot be taken back once someone has taken the shift');
select lives_ok($$select public.set_my_coop_day_absence(pg_temp.day(7), 'family', true, null)$$, 'a member marks the whole household out');
select is((select (dd ->> 'family_absent')::boolean from jsonb_array_elements(public.my_coop_days() -> 'days') dd
           where (dd ->> 'day')::date = private.coop_today() + 7), true, 'and sees it');
select lives_ok($$select public.set_my_coop_day_absence(pg_temp.day(7), 'family', false, null)$$, 'a household absence can be taken back');
reset role;
select pg_temp.as_user('b3');
set local role authenticated;
select lives_ok($$select public.withdraw_coop_cover((select (x ->> 'id')::uuid from jsonb_array_elements(public.my_coop_days() -> 'days') dd,
  jsonb_array_elements(dd -> 'my_covers') x where (dd ->> 'day')::date = private.coop_today() + 7))$$, 'the person covering can withdraw');
reset role;
select pg_temp.as_user('b2');
set local role authenticated;
select throws_ok($$select public.withdraw_coop_cover((select id from public.coop_days limit 1))$$, 'P0001', 'That cover was not found.',
  'a cover that is not there cannot be withdrawn');
reset role;
select pg_temp.as_user('c1');
set local role authenticated;
select throws_ok($$select public.my_coop_days()$$, '42501', 'Please sign in.', 'reviewer accounts have no co-op days');
reset role;

-- ---- points --------------------------------------------------------------------------------------------------------------------
-- Per co-op day from the Roles grid: Avery taught 1 = 2 points; Blake assisted 1 = 1; Casey taught 1 + assisted 1 = 3;
-- Drew hall monitor 1 = 1. Three past days (-21, -14, -7); -28 was cancelled; +7 has not happened.
select pg_temp.as_user('a1');
set local role authenticated;
create temp table pts as select public.admin_commitment_days(null) as d;
create or replace function pg_temp.earned(p text) returns integer language sql as $$
  select (x ->> 'earned')::integer from pts, jsonb_array_elements(d -> 'people') x
  where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000' || p; $$;
create or replace function pg_temp.hh(p text, k text) returns integer language sql as $$
  select (x ->> k)::integer from pts, jsonb_array_elements(d -> 'households') x
  where x ->> 'id' = '00000000-0000-0000-0000-0000000000' || p; $$;
select is(pg_temp.earned('b1'), 4, 'an adult earns nothing on a day they were out');
select is(pg_temp.earned('b2'), 2, 'and loses the shift someone covered when they did not come');
select is(pg_temp.earned('b3'), 6, 'a household''s day out earns nothing and costs nothing');
select is(pg_temp.earned('b4'), 6, 'covers earn their points (hall 3 + History lead 2 + assisting 1)');
select is((select (x ->> 'no_shows')::integer from pts, jsonb_array_elements(d -> 'people') x
           where x ->> 'user_id' = '00000000-0000-0000-0000-0000000000b2'), 1, 'the no-show is counted for administrators');
select is(pg_temp.hh('f1', 'expected'), 12, 'a household attending three days is expected 3 x 4 points');
select is(pg_temp.hh('f1', 'balance'), -6, 'and its balance is what it earned less that');
select is(pg_temp.hh('f2', 'expected'), 8, 'a day the household was out is not expected of it');
select is(pg_temp.hh('f2', 'balance'), -2, 'so its balance counts only the days it came');
select is((select d ->> 'day_points' from pts), '4', 'a co-op day is worth teach 1 x 2 + assist 2 x 1 points');
select lives_ok($$select public.admin_save_commitment_points(3, 1, 1)$$, 'an administrator changes the points');
select is((select (x ->> 'expected')::integer from jsonb_array_elements(public.admin_commitment_days(null) -> 'households') x
           where x ->> 'id' = '00000000-0000-0000-0000-0000000000f1'), 15, 'and the expectation follows');
select throws_ok($$select public.admin_save_commitment_points(11, 1, 1)$$, 'P0001', 'Points are whole numbers from 0 to 10.',
  'points out of range are refused');
select is((select (x ->> 'open_count')::integer from jsonb_array_elements(public.admin_commitment_days(null) -> 'days') x
           where (x ->> 'day')::date = private.coop_today() + 7), 2, 'administrators see the open shifts on each day');
select is((select count(*) from public.audit_log where action in ('coop_absence_marked', 'coop_shift_covered')), 8::bigint,
  'absences and covers are in the activity log');
reset role;

select * from finish();
rollback;
