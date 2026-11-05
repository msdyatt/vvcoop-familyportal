-- Class capacity and prerequisites (PR #9), enforced where a family enrolls a
-- child. An administrator placing a child by hand is deliberately not gated.
begin;
select plan(15);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'b@t.test',     'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000c', 'c@t.test',     'authenticated', 'authenticated');
update public.profiles set status = 'active' where email in ('admin@t.test', 'b@t.test', 'c@t.test');
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'parent'),
  ('00000000-0000-0000-0000-00000000000c', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Bee'),
  ('00000000-0000-0000-0000-0000000000f2', 'Cee');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000000b', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000000c', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', 'Kid One'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f2', 'Kid Two');

-- Math holds one seat and it is taken; Chemistry needs Biology; Art is open.
insert into public.classes (id, title, grades, active, capacity) values
  ('00000000-0000-0000-0000-0000000000a1', 'Math',      '{}', true, 1),
  ('00000000-0000-0000-0000-0000000000a2', 'Biology',   '{}', true, null),
  ('00000000-0000-0000-0000-0000000000a3', 'Chemistry', '{}', true, null),
  ('00000000-0000-0000-0000-0000000000a4', 'Art',       '{}', true, null);
insert into public.class_prerequisites (class_id, prerequisite_class_id) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a2');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e2', 'active');
insert into public.enrollment_periods (id, title, opens_at, closes_at, active) values
  ('00000000-0000-0000-0000-0000000000d1', 'Fall', now() - interval '1 hour', now() + interval '1 day', true);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
set local role authenticated;

-- what the class picker is told
select is((select is_full from public.family_enrollment_options('00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000a1']::uuid[])), true, 'the picker is told a full class is full');
select is((select is_full from public.family_enrollment_options('00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000a4']::uuid[])), false, 'and that an unlimited class is not');
select is((select missing_prerequisites from public.family_enrollment_options('00000000-0000-0000-0000-0000000000e1',
    array['00000000-0000-0000-0000-0000000000a3']::uuid[])), array['Biology'], 'and which prerequisite is missing');
select throws_ok(
  $$select * from public.family_enrollment_options('00000000-0000-0000-0000-0000000000e2', array['00000000-0000-0000-0000-0000000000a4']::uuid[])$$,
  'P0001', 'You do not have access to this child.', 'a family cannot ask about another household''s child');

-- what enrolling actually enforces
select throws_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1')$$,
  'P0001', 'That class is full.', 'a full class refuses a family');
select throws_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e1')$$,
  'P0001', 'This class needs Biology first.', 'a missing prerequisite refuses a family and names it');
select throws_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000e2')$$,
  'P0001', 'You do not have access to this child.', 'a family cannot enroll another household''s child');
select lives_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000e1')$$,
  'an open class accepts a family');
select lives_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e1')$$,
  'a class with no prerequisite accepts a family');
select lives_ok(
  $$select public.family_self_enroll('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e1')$$,
  'and once Biology is held, Chemistry does too');

-- families cannot edit the rules
select throws_ok(
  $$insert into public.class_prerequisites (class_id, prerequisite_class_id) values ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a2')$$,
  '42501', null, 'a family cannot add a prerequisite');

reset role;
select is((select count(*)::int from public.enrollments where child_id = '00000000-0000-0000-0000-0000000000e1' and status = 'active'), 3,
  'the three accepted enrollments exist, and the refused ones do not');

-- administrators are not gated by capacity
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$insert into public.enrollments (class_id, child_id, status) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', 'active')$$,
  'an admin can still place a child in a full class');
reset role;

select is(private.class_active_enrollment_count('00000000-0000-0000-0000-0000000000a1'), 2,
  'which puts Math over its single seat, by design');
select throws_ok(
  $$update public.classes set capacity = -1 where id = '00000000-0000-0000-0000-0000000000a1'$$,
  '23514', null, 'a negative capacity is rejected');

select * from finish();
rollback;
