-- Grade-based placement: History and Science place themselves by grade.
-- Fixtures (2026-27 is current, cutoff 1 Sept 2026; Science A is grades 3-5 with 2 seats,
-- Science B 6-8; History A 3-5, History B 6-8; Art is an elective; Lab is placed by hand):
--   Alpha: Ann (grade 4), Ann2 (grade 4, her sibling), Bo (born on the cutoff day: 6)
--   Bravo: Cy (born the day after: 5), Dee (grade set by hand to 7, birthdate says 3)
--   Charlie: Eli (no grade on file)   Delta: Fay (8)
--   Echo: not returning (Gus)   Demo: a reviewer household (Hal)
--   Yankee: Kit, already in Lab, which meets when the Science classes do
--   Zulu: Ivy, placed by hand in Science B although she is grade 4; Jon, withdrawn from History A by hand
begin;
select plan(52);

-- Runs a statement as whoever is current and says how many rows it touched.
create function public.t_rows(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute q; get diagnostics n = row_count; return n; end $$;
grant execute on function public.t_rows(text) to authenticated;

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'alpha@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'bravo@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'charlie@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'delta@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b5', 'echo@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b6', 'demo@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b7', 'yankee@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b8', 'zulu@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'teacher@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000c1', 'teacher');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Alpha'), ('00000000-0000-0000-0000-0000000000f2', 'Bravo'),
  ('00000000-0000-0000-0000-0000000000f3', 'Charlie'), ('00000000-0000-0000-0000-0000000000f4', 'Delta'),
  ('00000000-0000-0000-0000-0000000000f5', 'Echo'), ('00000000-0000-0000-0000-0000000000f6', 'Demo'),
  ('00000000-0000-0000-0000-0000000000f7', 'Yankee'), ('00000000-0000-0000-0000-0000000000f8', 'Zulu');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b4', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000b5', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b6', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000b7', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000b8', 'Parent');

insert into public.school_years (id, label, starts_on, ends_on, is_current) values
  ('00000000-0000-0000-0000-0000000000e1', '2026-27', date '2026-08-24', date '2027-05-28', true),
  ('00000000-0000-0000-0000-0000000000e2', '2027-28', date '2027-08-23', date '2028-05-26', false);

insert into public.children (id, family_id, first_name, birthdate, age_band_override, age_band) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000f1', 'Ann',  date '2017-09-01', false, null),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000f1', 'Ann2', date '2017-03-01', false, null),
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f1', 'Bo',   date '2015-09-01', false, null),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000f2', 'Cy',   date '2015-09-02', false, null),
  ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000f2', 'Dee',  date '2018-01-01', true, '7'),
  ('00000000-0000-0000-0000-00000000aa06', '00000000-0000-0000-0000-0000000000f3', 'Eli',  null, false, null),
  ('00000000-0000-0000-0000-00000000aa07', '00000000-0000-0000-0000-0000000000f4', 'Fay',  date '2013-01-01', false, null),
  ('00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-0000000000f5', 'Gus',  date '2017-05-05', false, null),
  ('00000000-0000-0000-0000-00000000aa09', '00000000-0000-0000-0000-0000000000f6', 'Hal',  date '2017-05-05', false, null),
  ('00000000-0000-0000-0000-00000000aa0a', '00000000-0000-0000-0000-0000000000f8', 'Ivy',  date '2017-05-05', false, null),
  ('00000000-0000-0000-0000-00000000aa0b', '00000000-0000-0000-0000-0000000000f8', 'Jon',  date '2017-05-05', false, null),
  ('00000000-0000-0000-0000-00000000aa0c', '00000000-0000-0000-0000-0000000000f7', 'Kit',  date '2017-05-05', false, null);

insert into public.class_blocks (id, school_year_id, label, starts_at, ends_at, sort_order, day_of_week) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'Block 1', time '09:00', time '10:00', 1, 5),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000e1', 'Block 2', time '10:15', time '11:15', 2, 5);
insert into public.classes (id, title, active, grades, is_elective, subject, capacity, school_year_id, block_id, is_demo) values
  ('00000000-0000-0000-0000-0000000000c1', 'Science A', true, '{3,4,5}', false, 'Science', 2,    '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', false),
  ('00000000-0000-0000-0000-0000000000c2', 'Science B', true, '{6,7,8}', false, 'science', null, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', false),
  ('00000000-0000-0000-0000-0000000000c3', 'History A', true, '{3,4,5}', false, 'History', null, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b2', false),
  ('00000000-0000-0000-0000-0000000000c4', 'History B', true, '{6,7,8}', false, 'History', null, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b2', false),
  ('00000000-0000-0000-0000-0000000000c5', 'Art',       true, '{}',      true,  null,      null, '00000000-0000-0000-0000-0000000000e1', null, false),
  ('00000000-0000-0000-0000-0000000000c6', 'Lab',       true, '{}',      false, null,      null, '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', false);
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000aa0a', 'active'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-00000000aa0b', 'withdrawn'),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-00000000aa0c', 'active');
-- Echo is not coming back in 2026-27 (the recorded answer).
insert into public.household_school_years (family_id, school_year_id, status) values
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e1', 'not_returning');

create temp table run1 (r jsonb);
create temp table run2 (r jsonb);
create temp table run3 (r jsonb);
create temp table run4 (r jsonb);
create temp table dry (r jsonb);
grant all on run1, run2, run3, run4, dry to public;

create function public.t_class(p_child text, p_class text) returns text language sql stable as $$
  select e.status || case when e.placed_by_grade then ' (grade)' else ' (hand)' end
  from public.enrollments e join public.classes c on c.id = e.class_id
  where e.child_id = ('00000000-0000-0000-0000-00000000aa' || p_child)::uuid and c.title = p_class $$;
grant execute on function public.t_class(text, text) to authenticated;

-- ---- who can call it ------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.admin_place_children_by_grade(uuid,boolean)', 'EXECUTE'), 'visitors cannot run placement');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1')$$, '42501', 'Administrator access is required.', 'a parent cannot run placement');
select throws_ok($$select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1', true)$$, '42501', 'Administrator access is required.', 'nor preview it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1')$$, '42501', 'Administrator access is required.', 'a teacher cannot either');
reset role;
select is((select count(*)::int from public.enrollments where placed_by_grade), 0, 'and nothing was placed by those attempts');

-- ---- the administrator: a preview writes nothing --------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into dry select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1', true);
reset role;
select is((select (r ->> 'dry_run')::boolean from dry), true, 'a preview says it is a preview');
select is((select (r -> 'counts' ->> 'placed')::int from dry), 13, 'and reports what it would place');
select is((select count(*)::int from public.enrollments where placed_by_grade), 0, 'but writes nothing');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000ff')$$, 'P0001', 'That school year does not exist.', 'an unknown year is refused');
reset role;

-- ---- the real run --------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run1 select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1');
reset role;
select is((select r -> 'counts' from run1), '{"placed": 13, "waitlisted": 2, "clash": 1, "manual": 1, "removed": 1, "no_grade": 2}'::jsonb, 'the report counts who was placed and who could not be');
select is(public.t_class('01', 'Science A'), 'active (grade)', 'Ann (grade 4) is in Science A');
select is(public.t_class('01', 'History A'), 'active (grade)', 'and History A');
select is(public.t_class('02', 'Science A'), 'active (grade)', 'her sibling Ann2 (same grade) goes with her');
select is(public.t_class('03', 'Science B'), 'active (grade)', 'a child born on the cutoff day is a grade up: Bo is in Science B');
select is(public.t_class('04', 'Science A'), 'waitlisted (grade)', 'a child born the next day is the lower grade: Cy wants Science A, which is full, so waits');
select is(public.t_class('04', 'History A'), 'active (grade)', 'and is in History A, which has room');
select is((select count(*)::int from public.enrollments where class_id = '00000000-0000-0000-0000-0000000000c1' and status = 'active'), 2, 'a full class stays at its limit');
select isnt(public.t_class('01', 'Science B'), 'active (grade)', 'siblings in different grades are in different classes (Ann is not in B)');
select is(public.t_class('05', 'Science B'), 'active (grade)', 'a grade set by hand beats the birthdate: Dee is in Science B');
select is((select count(*)::int from public.enrollments where child_id = '00000000-0000-0000-0000-00000000aa06'), 0, 'a child with no grade is not placed');
select is((select count(*)::int from jsonb_array_elements((select r -> 'items' from run1)) i where i ->> 'outcome' = 'no_grade' and i ->> 'child' = 'Eli'), 2, 'and is listed for both subjects with the reason');
select is((select count(*)::int from public.enrollments where child_id in ('00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-00000000aa09')), 0, 'households that are not returning, and reviewer households, are left out');
select is((select (r ->> 'skipped_not_returning')::int from run1), 1, 'the report says how many were skipped as not returning');
select is((select count(*)::int from public.enrollments where class_id = '00000000-0000-0000-0000-0000000000c5'), 0, 'an elective is never filled by placement');
select is(public.t_class('0a', 'Science B'), 'active (hand)', 'a placement made by hand is untouched (Ivy)');
select is((select count(*)::int from public.enrollments where child_id = '00000000-0000-0000-0000-00000000aa0a' and class_id = '00000000-0000-0000-0000-0000000000c1'), 0, 'and she is not also put in the grade-4 class');
select is(public.t_class('0b', 'History A'), 'withdrawn (hand)', 'a child withdrawn by hand is not put back (Jon)');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where e.child_id = '00000000-0000-0000-0000-00000000aa0b' and c.subject = 'History'), 1, 'nor into the other History class');
select is((select i ->> 'outcome' from jsonb_array_elements((select r -> 'items' from run1)) i where i ->> 'child' = 'Kit' and i ->> 'subject' = 'Science'), 'clash', 'a time clash with a class already held is reported, not double-booked (Kit)');
select is(public.t_class('0c', 'History A'), 'active (grade)', 'while Kit''s other subject is placed');

-- ---- running it again changes nothing ----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run2 select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1');
reset role;
select is((select (r -> 'counts' ->> 'placed')::int from run2), null, 'a second run places nobody new');
select is((select count(*)::int from public.enrollments where placed_by_grade), 15, 'and leaves the same rows (13 active, 2 waiting)');

-- ---- a correction: Ann's birthdate was wrong, she is really a grade up ---------------------------------------
update public.children set birthdate = date '2015-09-01' where id = '00000000-0000-0000-0000-00000000aa01';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run3 select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1');
reset role;
select is(public.t_class('01', 'Science B'), 'active (grade)', 'Ann moves to the class for her corrected grade');
select is((select count(*)::int from public.enrollments where child_id = '00000000-0000-0000-0000-00000000aa01' and class_id = '00000000-0000-0000-0000-0000000000c1'), 0, 'and is out of the old one');
select is(public.t_class('01', 'History B'), 'active (grade)', 'in every subject');
select is(public.t_class('04', 'Science A'), 'active (grade)', 'Cy, waiting, gets the seat she left (promoted)');
select is(public.t_class('0b', 'Science A'), 'waitlisted (grade)', 'and Jon, next in line, still waits');
select is(public.t_class('0a', 'Science B'), 'active (hand)', 'the placement by hand is still untouched');

-- ---- a seat appears --------------------------------------------------------------------------------------------------
update public.classes set capacity = 3 where id = '00000000-0000-0000-0000-0000000000c1';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
insert into run4 select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1');
reset role;
select is(public.t_class('0b', 'Science A'), 'active (grade)', 'a larger class takes the next child off the waitlist');

-- ---- problems with the classes themselves are called out -------------------------------------------------------------
insert into public.classes (id, title, active, grades, is_elective, subject, school_year_id, is_demo) values
  ('00000000-0000-0000-0000-0000000000c7', 'Science Z', true, '{}', false, 'Science', '00000000-0000-0000-0000-0000000000e1', false),
  ('00000000-0000-0000-0000-0000000000c8', 'History C', true, '{5,6}', false, 'History', '00000000-0000-0000-0000-0000000000e1', false);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
truncate dry;
insert into dry select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e1', true);
reset role;
select ok((select bool_or(w ->> 'kind' = 'no_grades' and w ->> 'detail' like '%Science Z%') from jsonb_array_elements((select r -> 'warnings' from dry)) w), 'a grade-assigned class with no grades is flagged');
select ok((select bool_and(w ->> 'kind' = 'overlap') and count(*) = 2 from jsonb_array_elements((select r -> 'warnings' from dry)) w where w ->> 'kind' = 'overlap'), 'and so are two History classes that both cover grades 5 and 6');
delete from public.classes where id in ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000c8');

-- ---- families choose electives, never grade-assigned classes ---------------------------------------------------------
insert into public.enrollment_periods (id, title, opens_at, closes_at, active, electives_only, school_year_id) values
  ('00000000-0000-0000-0000-0000000000f0', 'Open now', now() - interval '1 day', now() + interval '1 day', true, false, '00000000-0000-0000-0000-0000000000e1');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.family_self_enroll('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-00000000aa02')$$, 'a family can still enroll a child in an elective');
select throws_ok($$select public.family_self_enroll('00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000aa03')$$, 'P0001', '%can''t be enrolled right now%', 'but not in a grade-assigned class, even in an open window and the right grade');
reset role;

-- ---- the class itself ---------------------------------------------------------------------------------------------------
select throws_ok($$update public.classes set is_elective = true where id = '00000000-0000-0000-0000-0000000000c1'$$, '23514', null, 'a class cannot be both an elective and placed by grade');

-- ---- rolling into next year, with placement as an option ------------------------------------------------------------------
-- Next year's grades come from the birthdate against next year's cutoff, even though 2027-28 is not current:
-- Ann2 (born 2017-03-01) is grade 4 now and 5 then; Fay (13 on 1 Sept 2026) is a grade up too.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select r -> 'placement' from (select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{}'::jsonb, array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[]) as r) p), 'null'::jsonb, 'without the option the rollover places nobody');
truncate dry;
insert into dry select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{"place_children": true}'::jsonb, array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[]);
reset role;
select is((select (r -> 'placement' -> 'counts' ->> 'placed')::int from dry), 10, 'a preview with the option says who it would place: five children, two subjects each');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e2'), 0, 'and a preview wrote nothing');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
truncate dry;
insert into dry select public.admin_rollover_school_year('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '{"place_children": true}'::jsonb, array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2']::uuid[]);
reset role;
select is((select c.subject from public.classes c where c.school_year_id = '00000000-0000-0000-0000-0000000000e2' and c.title = 'Science A'), 'Science', 'a copied class keeps its subject');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e2' and e.child_id in ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000aa05')), 10, 'returning households are placed in next year''s classes');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e2' and e.child_id not in ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000aa05')), 0, 'and households not moving forward are not');
select is((select count(*)::int from public.enrollments e join public.classes c on c.id = e.class_id where c.school_year_id = '00000000-0000-0000-0000-0000000000e1' and e.placed_by_grade), 15, 'this year''s placements are exactly as they were');
select ok((select (detail -> 'placement') is not null and (detail #> '{placement,items}') is null from public.audit_log where action = 'school_year_rolled_over' order by created_at desc limit 1), 'the audit entry keeps the placement counts but not the per-child list');

select * from finish();
rollback;
