-- Automatic event reminders: 3 days and 1 day before, to exactly the people who can see the event.
-- Fixtures: A1 administrator; T teacher of C1; P1 and P2 parents in C1 (P2 turns reminders off);
-- P3 parent with no class; P4 parent whose child withdrew from C1; X inactive; D a reviewer (demo)
-- parent; E an account on the reviewer email domain.
-- Times are passed to the runner explicitly (p_now), so nothing depends on today's date.
begin;
select plan(85);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p4@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b9', 'inactive@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d1', 'demo@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000d2', 'reviewer@demo.veritasvillage.org', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email not like 'inactive@%';
update public.profiles set is_demo = true where email = 'demo@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'), ('00000000-0000-0000-0000-0000000000b4', 'parent'),
  ('00000000-0000-0000-0000-0000000000b9', 'parent'),
  ('00000000-0000-0000-0000-0000000000d1', 'parent'), ('00000000-0000-0000-0000-0000000000d2', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'),
  ('00000000-0000-0000-0000-0000000000f3', 'Three'), ('00000000-0000-0000-0000-0000000000f4', 'Four');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b4', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f2', 'K2'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000f4', 'K4');
insert into public.classes (id, title, grades, active) values ('00000000-0000-0000-0000-0000000000e1', 'Class One', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c2', 'active'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c4', 'withdrawn');

-- P2 turns event reminders off (through the same function the settings screen uses).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is(public.my_event_reminders(), true, 'event reminders are on by default');
select lives_ok($$select public.set_my_event_reminders(false)$$, 'a person can switch them off');
select lives_ok($$select public.set_my_notification_preferences(true, true, false)$$, 'saving the push and email choices afterwards');
select is(public.my_event_reminders(), false, 'does not switch them back on');
reset role;
set local role anon;
select throws_ok($$select public.set_my_event_reminders(true)$$, '42501', null, 'someone signed out cannot change it');
reset role;

-- ---- events -------------------------------------------------------------------------------------------
-- Thursday 10 December 2026, in Central time (CST, UTC-6):
insert into public.events (id, title, starts_at, audience, class_id, all_day, location, is_demo, send_reminders) values
  ('00000000-0000-0000-0000-000000000e01', 'Picture day',     '2026-12-10T00:00:00Z', 'families', null, true,  null, false, true),   -- all-day: UTC midnight
  ('00000000-0000-0000-0000-000000000e02', 'Reading circle',  '2026-12-10T12:00:00Z', 'class', '00000000-0000-0000-0000-0000000000e1', true, 'Room 4', false, true), -- a teacher's all-day: UTC midday
  ('00000000-0000-0000-0000-000000000e03', 'Teacher meeting', '2026-12-10T21:00:00Z', 'teachers', null, false, null, false, true),
  ('00000000-0000-0000-0000-000000000e04', 'Co-op meeting',   '2026-12-10T15:00:00Z', 'families', null, false, 'Hall', false, true), -- 9:00 AM
  ('00000000-0000-0000-0000-000000000e05', 'Lunch',           '2026-12-10T19:00:00Z', 'families', null, false, null, false, true),  -- 1:00 PM
  ('00000000-0000-0000-0000-000000000e06', 'Silent',          '2026-12-10T00:00:00Z', 'families', null, true,  null, false, false), -- reminders off
  ('00000000-0000-0000-0000-000000000e07', 'Sample event',    '2026-12-10T00:00:00Z', 'families', null, true,  null, true,  true),  -- reviewer's
  ('00000000-0000-0000-0000-000000000e08', 'Night owl',       '2026-12-11T04:00:00Z', 'public',   null, false, null, false, true),  -- 10:00 PM on the 10th, Chicago
-- Monday 14 December:
  ('00000000-0000-0000-0000-000000000e10', 'Field trip',      '2026-12-14T15:00:00Z', 'families', null, false, null, false, true),
  ('00000000-0000-0000-0000-000000000e11', 'Potluck',         '2026-12-14T19:00:00Z', 'families', null, false, null, false, true),
-- Daylight saving (clocks went back Sunday 1 Nov 2026 and go forward Sunday 14 Mar 2027):
  ('00000000-0000-0000-0000-000000000e20', 'Wednesday',       '2026-11-04T00:00:00Z', 'families', null, true, null, false, true),
  ('00000000-0000-0000-0000-000000000e21', 'Monday',          '2026-11-02T00:00:00Z', 'families', null, true, null, false, true),
  ('00000000-0000-0000-0000-000000000e22', 'Spring Tuesday',  '2027-03-16T00:00:00Z', 'families', null, true, null, false, true),
-- Far ahead, for the outage, late-add, moved and cancelled cases:
  ('00000000-0000-0000-0000-000000000e30', 'Added late',      '2027-01-12T00:00:00Z', 'families', null, true, null, false, true),
  ('00000000-0000-0000-0000-000000000e31', 'Moved party',     '2027-01-20T00:00:00Z', 'families', null, true, null, false, true),
  ('00000000-0000-0000-0000-000000000e33', 'Cancelled event', '2027-02-10T00:00:00Z', 'families', null, true, null, false, true),
  ('00000000-0000-0000-0000-000000000e34', 'Outage day',      '2026-12-30T00:00:00Z', 'families', null, true, null, false, true);
-- Every fixture event has been there for a long time, except the one that is added late below.
update public.events set reminders_from = '2000-01-01';
update public.events set reminders_from = '2027-01-09T16:00:00Z' where id = '00000000-0000-0000-0000-000000000e30';

-- ---- the defaults and the schedule -------------------------------------------------------------------------
select is((select enabled::text || '|' || send_time::text || '|' || offsets_days::text || '|' || timezone from public.event_reminder_settings), 'true|09:00:00|{3,1}|America/Chicago', 'on, at 9:00 AM Chicago time, 3 days and 1 day before');
select is((select schedule from cron.job where jobname = 'event-reminders'), '*/5 * * * *', 'the runner is scheduled every five minutes');

-- ---- local dates and send times -------------------------------------------------------------------------------
select is((select event_date from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e01' and offset_days = 3), '2026-12-10'::date, 'an all-day event stored at UTC midnight keeps its own date (not the evening before)');
select is((select event_date from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e02' and offset_days = 3), '2026-12-10'::date, 'so does one stored at UTC midday');
select is((select event_date from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e08' and offset_days = 3), '2026-12-10'::date, 'a timed event late in the evening is on its Chicago date, not the next UTC day');
select is((select due_at from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e01' and offset_days = 3), '2026-12-07T15:00:00Z'::timestamptz, '3 days before is 9:00 AM Chicago time (15:00 UTC in winter)');
select is((select due_at from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e01' and offset_days = 1), '2026-12-09T15:00:00Z'::timestamptz, 'and 1 day before');
select is((select due_at from private.event_reminder_plan('2026-10-01', '2026-12-01') where event_id = '00000000-0000-0000-0000-000000000e20' and offset_days = 3), '2026-11-01T15:00:00Z'::timestamptz, 'the day clocks fall back: 9:00 AM is now 15:00 UTC');
select is((select due_at from private.event_reminder_plan('2026-10-01', '2026-12-01') where event_id = '00000000-0000-0000-0000-000000000e21' and offset_days = 3), '2026-10-30T14:00:00Z'::timestamptz, 'the Friday before it is still summer time, 14:00 UTC');
select is((select due_at from private.event_reminder_plan('2027-03-01', '2027-04-01') where event_id = '00000000-0000-0000-0000-000000000e22' and offset_days = 3), '2027-03-13T15:00:00Z'::timestamptz, 'the day before clocks go forward is still winter time');
select is((select due_at from private.event_reminder_plan('2027-03-01', '2027-04-01') where event_id = '00000000-0000-0000-0000-000000000e22' and offset_days = 1), '2027-03-15T14:00:00Z'::timestamptz, 'and the day after is summer time, 14:00 UTC');
select is((select count(*)::int from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id in ('00000000-0000-0000-0000-000000000e06', '00000000-0000-0000-0000-000000000e07')), 0, 'nothing is planned for an event with reminders switched off, or a reviewer''s event');

-- Daylight saving, through the runner: nothing at 8:30 AM Chicago time, it goes at 9:00.
select is((private.run_event_reminders('2026-11-01T14:30:00Z') ->> 'notifications')::int, 0, 'on the clock-change day nothing goes out an hour early');
select is((select count(*)::int from public.notifications where kind = 'event_reminder'), 0, 'nothing has been created yet');
select is((private.run_event_reminders('2026-11-01T15:00:30Z') ->> 'notifications')::int > 0, true, 'and at 9:00 AM it goes');
delete from public.notifications where kind = 'event_reminder';
delete from public.event_reminder_log;

-- ---- before the time, then at the time -----------------------------------------------------------------------
select is((private.run_event_reminders('2026-12-07T14:59:00Z') ->> 'notifications')::int, 0, 'a minute before 9:00 AM nothing goes out');
select is((private.run_event_reminders('2026-12-07T15:00:30Z') -> 'notifications')::text, '5', 'at 9:00 AM five people are reminded, once each');
select is((select count(*)::int from public.notifications where kind = 'event_reminder'), 5, 'one notification per person, however many events they have that day');
select is((select count(*)::int from public.event_reminder_log), 24, 'and a log row for each person and event');

-- who, per event type
select is((select title from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 'In 3 days: 5 events', 'a family in the class: everyone''s events, the public one and the class''s');
select is((select title from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b3'), 'In 3 days: 4 events', 'a family with no class: not the class event');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and body like '%Reading circle (Room 4)%' and body like 'Thursday, December 10%'), 1, 'the class event is in the class family''s reminder, with its room and the date');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b4' and body like '%Reading circle%'), 0, 'a family whose child withdrew from the class does not get the class event');
select is((select title from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a2'), 'In 3 days: 6 events', 'the class''s teacher gets the class and teaching-team events too');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a1' and body like '%Teacher meeting%' and body not like '%Reading circle%'), 1, 'an administrator gets teaching-team events (they can see them) but not a class''s');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b2'), 0, 'someone who switched event reminders off gets nothing');
select is((select count(*)::int from public.notifications where recipient_user_id in ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2')), 0, 'an inactive account, a reviewer account and an account on the reviewer email domain get nothing');
select is((select count(*)::int from public.notifications where kind = 'event_reminder' and (body like '%Silent%' or body like '%Sample event%')), 0, 'the event with reminders off and the reviewer''s event are never mentioned');
select is((select count(*)::int from public.notifications where kind = 'event_reminder' and link_path = '/family-village/calendar' and subject_type = 'event'), 5, 'each links to the calendar');
select is((select count(*)::int from private.ladder_due(now() + interval '30 days') d join public.notifications n on n.id = d.notification_id where n.kind = 'event_reminder'), 0, 'reminders are not important: never emailed or texted by the fallback');

-- ---- never twice ----------------------------------------------------------------------------------------------
select is((private.run_event_reminders('2026-12-07T15:00:30Z') ->> 'notifications')::int, 0, 'running again at the same moment sends nothing');
select is((private.run_event_reminders('2026-12-07T15:04:30Z') ->> 'notifications')::int, 0, 'nor five minutes later');
select is((select count(*)::int from public.notifications where kind = 'event_reminder'), 5, 'still five notifications');

-- ---- the day-before reminder, and an outage ------------------------------------------------------------------
select is((private.run_event_reminders('2026-12-09T15:00:30Z') -> 'notifications')::text, '5', 'the next morning the 1-day reminders go out');
select is((select title from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and title like 'Tomorrow%'), 'Tomorrow: 5 events', 'worded as tomorrow');
select is((private.run_event_reminders('2026-12-27T19:00:00Z') ->> 'notifications')::int, 0, 'a reminder that is more than three hours late is not sent (the system was down)');
select is((select count(*)::int from public.notifications where body like '%Outage day%'), 0, 'so nobody hears about "tomorrow" a day late');

-- ---- one combined reminder --------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[3, 1], array['p1@t.test'])$$, 'an administrator can switch on test mode for chosen people');
reset role;
select is((private.run_event_reminders('2026-12-11T15:00:30Z') ->> 'notifications')::int, 1, 'in test mode only the listed person is reminded');
select is((select title from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and body like '%Field trip%'), 'In 3 days: Field trip at 9:00 AM, Potluck at 1:00 PM', 'two events the same day are one reminder, with their times');
select is((select count(*)::int from public.notifications where body like '%Field trip%' and recipient_user_id <> '00000000-0000-0000-0000-0000000000b1'), 0, 'and nobody else heard');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_event_reminder_test_emails(), array['p1@t.test'], 'the settings screen can read the test list back');
select lives_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[3, 1], array[]::text[])$$, 'test mode is switched off again');
reset role;
select is((private.run_event_reminders('2026-12-11T15:05:00Z') ->> 'notifications')::int, 4, 'then the others get theirs, and the person already reminded is not reminded twice');
select is((select count(*)::int from public.notifications where body like '%Field trip%' and recipient_user_id = '00000000-0000-0000-0000-0000000000b1'), 1, 'once');

-- ---- added late, moved, cancelled ---------------------------------------------------------------------------
select is((select skipped from private.event_reminder_plan('2027-01-01', '2027-02-01') where event_id = '00000000-0000-0000-0000-000000000e30' and offset_days = 3), true, 'an event added after its 3-day reminder was due is marked as skipped');
select is((select skipped from private.event_reminder_plan('2027-01-01', '2027-02-01') where event_id = '00000000-0000-0000-0000-000000000e30' and offset_days = 1), false, 'but its 1-day reminder is still to come');
select is((private.run_event_reminders('2027-01-09T15:00:30Z') ->> 'notifications')::int, 0, 'so the reminder that was already past is not sent');
select is((private.run_event_reminders('2027-01-11T15:00:30Z') ->> 'notifications')::int > 0, true, 'and the later one is');

select is((private.run_event_reminders('2027-01-17T15:00:30Z') ->> 'notifications')::int > 0, true, 'an event gets its 3-day reminder');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
update public.events set starts_at = '2027-01-27T00:00:00Z' where id = '00000000-0000-0000-0000-000000000e31';
reset role;
select is((select reminders_from = now() from public.events where id = '00000000-0000-0000-0000-000000000e31'), true, 'moving it restarts its reminders from that moment');
update public.events set reminders_from = '2027-01-18T00:00:00Z' where id = '00000000-0000-0000-0000-000000000e31';
select is((private.run_event_reminders('2027-01-19T15:00:30Z') ->> 'notifications')::int, 0, 'the old date''s 1-day reminder no longer goes out');
select is((private.run_event_reminders('2027-01-24T15:00:30Z') ->> 'notifications')::int > 0, true, 'the new date gets its own 3-day reminder, even though one went out for the old date');
select is((select count(*)::int from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and title like '%Moved party%'), 2, 'one for each date');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
update public.events set reminders_from = '1990-01-01' where id = '00000000-0000-0000-0000-000000000e33';
update public.events set title = 'Cancelled event (renamed)' where id = '00000000-0000-0000-0000-000000000e33';
reset role;
select is((select reminders_from from public.events where id = '00000000-0000-0000-0000-000000000e33'), '2000-01-01'::timestamptz, 'a client cannot move the start of an event''s reminders by hand, and renaming it changes nothing');
delete from public.events where id = '00000000-0000-0000-0000-000000000e33';
select is((private.run_event_reminders('2027-02-07T15:00:30Z') ->> 'notifications')::int, 0, 'a cancelled event sends nothing');

-- ---- the per-event switch ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
update public.events set send_reminders = true where id = '00000000-0000-0000-0000-000000000e06';
reset role;
select is((select count(*)::int from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e06'), 2, 'switching reminders on for an event plans both');
select is((select reminders_from = now() from public.events where id = '00000000-0000-0000-0000-000000000e06'), true, 'from that moment, so reminders already past are not sent late');

-- ---- who may change the settings --------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[3, 1], array[]::text[])$$, '42501', 'Administrator access is required.', 'a parent cannot change the settings');
select throws_ok($$select * from public.admin_upcoming_event_reminders(21, '2026-12-01')$$, '42501', 'Administrator access is required.', 'or see the upcoming list');
select is((select count(*)::int from public.event_reminder_settings), 0, 'or read them');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_event_reminder_settings(false, '09:00', array[3, 1], array[]::text[])$$, '42501', 'Administrator access is required.', 'nor can a teacher');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_event_reminder_settings(true, '05:00', array[3, 1], array[]::text[])$$, 'P0001', 'Choose a time between 6:00 AM and 9:00 PM.', 'a reminder at 5:00 AM is refused');
select throws_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[]::integer[], array[]::text[])$$, 'P0001', 'Choose one to three reminders, each 0 to 30 days before.', 'having no reminders at all is refused (switch them off instead)');
select throws_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[31], array[]::text[])$$, 'P0001', 'Choose one to three reminders, each 0 to 30 days before.', 'so is a reminder more than 30 days ahead');
select throws_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[7, 3, 2, 1], array[]::text[])$$, 'P0001', 'Choose one to three reminders, each 0 to 30 days before.', 'or four of them');
select throws_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[3, 1], array['nobody@t.test'])$$, 'P0001', 'No one has the email nobody@t.test.', 'and a test-mode address nobody has');
select lives_ok($$select public.admin_update_event_reminder_settings(true, '07:30', array[2], array[]::text[])$$, 'the time and the offsets can be changed');
reset role;
select is((select due_at from private.event_reminder_plan('2026-12-01', '2026-12-31') where event_id = '00000000-0000-0000-0000-000000000e01'), '2026-12-08T13:30:00Z'::timestamptz, 'one reminder, 2 days before, at 7:30 AM Chicago time (13:30 UTC)');
select is((select count(*)::int from public.audit_log where action = 'event_reminder_settings_updated' and actor_user_id = '00000000-0000-0000-0000-0000000000a1'), 3, 'each change is in the audit log');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_update_event_reminder_settings(false, '09:00', array[3, 1], array[]::text[])$$, 'an administrator can switch reminders off altogether');
reset role;
select is((private.run_event_reminders('2026-12-11T15:30:00Z') ->> 'disabled')::boolean, true, 'then the runner does nothing');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_update_event_reminder_settings(true, '09:00', array[3, 1], array[]::text[])$$, 'and on again');
reset role;

-- ---- what the administrator sees ------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select status || '|' || recipients::text from public.admin_upcoming_event_reminders(21, '2026-12-06') where event_id = '00000000-0000-0000-0000-000000000e01' and offset_days = 3), 'sent|5', 'the upcoming list shows what has gone out and to how many people');
select is((select status from public.admin_upcoming_event_reminders(21, '2026-12-06') where event_id = '00000000-0000-0000-0000-000000000e10' and offset_days = 1), 'scheduled', 'and what is still to go');
select is((select send_label from public.admin_upcoming_event_reminders(21, '2026-12-06') where event_id = '00000000-0000-0000-0000-000000000e10' and offset_days = 1), 'Sun, Dec 13 at 9:00 AM', 'with when, in Central time');
select is((select status from public.admin_upcoming_event_reminders(60, '2027-01-08') where event_id = '00000000-0000-0000-0000-000000000e30' and offset_days = 3), 'skipped', 'and what was skipped because the event was added too late');
select is((select recipients from public.admin_upcoming_event_reminders(21, '2026-12-06') where event_id = '00000000-0000-0000-0000-000000000e10' and offset_days = 1), 5, 'with how many people it will reach');
reset role;

-- ---- a lead teacher's class event is covered by default -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into public.events (id, title, starts_at, audience, class_id, all_day) values ('00000000-0000-0000-0000-000000000e40', 'Class trip', '2027-03-01T12:00:00Z', 'class', '00000000-0000-0000-0000-0000000000e1', true)$$, 'a lead teacher adds a class event');
reset role;
select is((select send_reminders and reminders_from = now() from public.events where id = '00000000-0000-0000-0000-000000000e40'), true, 'it sends reminders by default, starting from when it was added');

select * from finish();
rollback;
