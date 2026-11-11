-- Broadcasts: only administrators can preview or send, the audience rules (class, grade, teachers,
-- hand-picked, never reviewer or suspended profiles, blocks respected below urgent), urgent goes out at
-- once on every allowed channel, a double click sends once, rate limits, the family-side "Got it", and
-- the delivery report.
begin;
select plan(101);

-- Admins A1, A2. Parents B1 (class C1, device), B2 (withdrawn from C1, no device), B3 (email off, no
-- device), B4 (device, agreed to texts), B5 (device, blocked A1), Q (device, only-urgent mode), D (demo),
-- S (suspended). Teachers T1 (assigned to C1, device), T2 (no device).
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'a1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'a2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'b1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'b2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'b3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'b4@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b5', 'b5@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b6', 'q@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b7', 'd@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b8', 's@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 't1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c2', 't2@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test';
update public.profiles set status = 'suspended' where email = 's@t.test';
update public.profiles set is_demo = true where email = 'd@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000c1', 'teacher'), ('00000000-0000-0000-0000-0000000000c2', 'teacher');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'F1'), ('00000000-0000-0000-0000-0000000000f2', 'F2'),
  ('00000000-0000-0000-0000-0000000000f3', 'F3'), ('00000000-0000-0000-0000-0000000000f4', 'F4'),
  ('00000000-0000-0000-0000-0000000000f5', 'F5'), ('00000000-0000-0000-0000-0000000000f6', 'F6'),
  ('00000000-0000-0000-0000-0000000000f7', 'F7'), ('00000000-0000-0000-0000-0000000000f8', 'F8');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b4', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000b5', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b6', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000b7', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000b8', 'Parent');
insert into public.children (id, family_id, first_name, age_band, active) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000f1', 'Kid1', 'K', true),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000f2', 'Kid2', '3', true),
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000f3', 'Kid3', '3', true),
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000f4', 'Kid4', 'K', true),
  ('00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000f5', 'Kid5', 'K', true),
  ('00000000-0000-0000-0000-00000000aa06', '00000000-0000-0000-0000-0000000000f6', 'Kid6', 'K', true),
  ('00000000-0000-0000-0000-00000000aa07', '00000000-0000-0000-0000-0000000000f7', 'Kid7', 'K', true),
  ('00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-0000000000f8', 'Kid8', 'K', true);
insert into public.classes (id, title, active) values ('00000000-0000-0000-0000-0000000000c9', 'Latin I', true);
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-00000000aa01', 'active'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-00000000aa02', 'withdrawn');
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000c1', 'lead');
insert into public.push_subscriptions (user_id, platform, device_token)
select u.id, 'ios', 'token-' || u.email from auth.users u where u.email in ('b1@t.test', 'b4@t.test', 'b5@t.test', 'q@t.test', 'd@t.test', 's@t.test', 't1@t.test');
insert into public.notification_preferences (user_id, email_enabled) values ('00000000-0000-0000-0000-0000000000b3', false);
insert into public.notification_preferences (user_id, quiet_mode) values ('00000000-0000-0000-0000-0000000000b6', true);
insert into public.notification_preferences (user_id, sms_enabled, sms_phone, sms_consent_at, sms_consent_method, sms_consent_wording) values
  ('00000000-0000-0000-0000-0000000000b4', true, '+15555550104', now() - interval '3 days', 'account_settings_checkbox', 'v1');
insert into public.user_blocks (blocker_id, blocked_id) values ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1');

-- ---- who is allowed ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_broadcast_preview('{"type":"everyone"}', 'notice')$$, '42501', null, 'a parent cannot preview a broadcast');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e001', 'Hi', 'Hi', 'notice', '{"type":"everyone"}')$$, '42501', null, 'a parent cannot send one');
select throws_ok($$select public.admin_broadcast_report('00000000-0000-0000-0000-00000000e001')$$, '42501', null, 'or read a report');
select throws_ok($$select * from public.admin_broadcast_history(10)$$, '42501', null, 'or the history');
select throws_ok($$select public.admin_save_broadcast_template('X', 'notice', 't', 'b')$$, '42501', null, 'or save a template');
select throws_ok($$select public.admin_end_broadcast('00000000-0000-0000-0000-00000000e001')$$, '42501', null, 'or end an alert');
select is((select count(*)::int from public.broadcasts), 0, 'and reads no broadcasts directly');
select is((select count(*)::int from public.broadcast_templates), 0, 'or templates');
reset role;
set local role anon;
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e001', 'Hi', 'Hi', 'notice', '{"type":"everyone"}')$$, '42501', null, 'a signed-out visitor cannot send');
select throws_ok($$select * from public.my_active_urgent_broadcasts()$$, '42501', null, 'or read alerts');
reset role;

-- ---- the audience ---------------------------------------------------------------------------------------
create function pg_temp.audience(p_audience jsonb, p_severity text) returns text language sql as $$
  select coalesce(string_agg(p.display_name, ',' order by p.display_name), '')
  from private.broadcast_audience(p_audience, '00000000-0000-0000-0000-0000000000a1', p_severity) a join public.profiles p on p.id = a.user_id;
$$;
select is(pg_temp.audience('{"type":"class","class_id":"00000000-0000-0000-0000-0000000000c9"}', 'notice'), 'b1,t1', 'a class reaches the families enrolled in it and its teachers, not withdrawn ones');
select is(pg_temp.audience('{"type":"grade","grade":"3"}', 'notice'), 'b2,b3', 'a grade reaches the parents of children in that grade');
select is(pg_temp.audience('{"type":"teachers"}', 'notice'), 't1,t2', 'teachers reaches the teachers');
select is(pg_temp.audience('{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b1","00000000-0000-0000-0000-0000000000b7","00000000-0000-0000-0000-0000000000b8"]}', 'notice'), 'b1',
  'a hand-picked set never includes a reviewer or suspended profile');
select ok(pg_temp.audience('{"type":"everyone"}', 'notice') not like '%d,%' and pg_temp.audience('{"type":"everyone"}', 'notice') not like '%s%@%', 'everyone leaves out reviewer and suspended profiles');
select ok(pg_temp.audience('{"type":"everyone"}', 'notice') not like '%b5%', 'below urgent, someone who blocked the sender is left out');
select ok(pg_temp.audience('{"type":"everyone"}', 'urgent') like '%b5%', 'an urgent alert reaches them anyway');
select throws_ok($$select * from private.broadcast_audience('{"type":"nobody"}', null, 'notice')$$, 'P0001', 'Choose who should receive this.', 'an unknown audience is refused');

-- ---- the preview -----------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table pv_notice as select public.admin_broadcast_preview('{"type":"everyone"}', 'notice') as j;
create temp table pv_urgent as select public.admin_broadcast_preview('{"type":"everyone"}', 'urgent') as j;
reset role;
select is((select j ->> 'total' from pv_notice), '9', 'a notice to everyone reaches 9 people (the one who blocked the sender is left out)');
select is((select j ->> 'push' from pv_notice), '3', 'three by push');
select is((select j ->> 'email_only' from pv_notice), '4', 'four by email only (no app)');
select is((select j ->> 'unreachable' from pv_notice), '2', 'two unreachable: no way to reach one, the other only wants urgent things');
select is((select j ->> 'quiet_held' from pv_notice), '1', 'the preview says one is held back by only-urgent mode');
select is((select j ->> 'total' from pv_urgent), '10', 'an urgent alert reaches 10: blocks do not apply');
select is((select j ->> 'push' from pv_urgent), '5', 'five by push, including the only-urgent person');
select is((select j ->> 'unreachable' from pv_urgent), '1', 'one unreachable');
select is((select j ->> 'immediate' from pv_urgent), 'true', 'and it says the alert goes out immediately');
select is((select (j ->> 'push')::int + (j ->> 'email_only')::int + (j ->> 'sms_only')::int + (j ->> 'unreachable')::int = (j ->> 'total')::int from pv_urgent), true,
  'every person is counted once');
select is((select j ->> 'sms' from pv_urgent), '0', 'no one is textable while the master switch is off');
update public.notification_settings set sms_enabled = true;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_broadcast_preview('{"type":"everyone"}', 'urgent') ->> 'sms', '1', 'with it on, the one person who agreed to texts is counted');
select is(public.admin_broadcast_preview('{"type":"everyone"}', 'urgent') ->> 'also_sms', '1', 'as an extra on top of push');
select is(public.admin_broadcast_preview('{"type":"everyone"}', 'notice') ->> 'sms', '0', 'but a notice is never texted');
select is(public.admin_broadcast_preview('{"type":"people","user_ids":[]}', 'notice') ->> 'total', '0', 'an empty audience previews as nobody, not everybody');
reset role;

-- ---- sending an urgent alert ------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e101', 'Closed', 'Snow day', 'urgent', '{"type":"class","class_id":"00000000-0000-0000-0000-0000000000c9"}')$$,
  'P0001', 'Confirm that this is an urgent alert before sending.', 'an urgent alert needs the explicit confirmation');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e102', '', 'Snow day', 'notice', '{"type":"everyone"}')$$, 'P0001', null, 'an empty title is refused');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e103', 'Hi', 'Hi', 'loud', '{"type":"everyone"}')$$, 'P0001', null, 'an unknown severity is refused');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e104', 'Hi', 'Hi', 'notice', '{"type":"people","user_ids":[]}')$$, 'P0001', 'No one would receive this. Check who it is for.', 'an audience of nobody is refused');
select is((select count(*)::int from public.broadcasts), 0, 'and none of that created anything');
select is(public.admin_send_broadcast('00000000-0000-0000-0000-00000000e101', 'Closed today', 'Snow day. Stay home.', 'urgent', '{"type":"class","class_id":"00000000-0000-0000-0000-0000000000c9"}', 'weather', true) ->> 'recipients', '2',
  'an urgent alert to the class goes to its two people');
select is((select count(*)::int from public.broadcasts), 1, 'one broadcast exists');
select is((select recipient_count from public.broadcasts), 2, 'with its recipient count');
select ok((select audience_label = 'Class: Latin I' from public.broadcasts), 'and a readable audience');
reset role;
select is((select count(*)::int from public.notifications where kind = 'broadcast_urgent'), 2, 'each recipient has a bell notification');
select is((select count(*)::int from public.broadcast_recipients), 2, 'and a recipient row');
select is((select count(*)::int from public.notification_deliveries where channel = 'email' and status = 'queued'), 2, 'email is queued at once for both, with no 24 hour wait');
select is((select count(*)::int from public.notification_deliveries where channel = 'sms'), 0, 'no text, because neither agreed to texts');
select is((select count(*)::int from public.notification_deliveries where channel = 'push'), 0, 'push is left for deliver-push: both have a device');
select ok(exists (select 1 from public.audit_log where action = 'broadcast_sent' and actor_user_id = '00000000-0000-0000-0000-0000000000a1' and detail ->> 'severity' = 'urgent'), 'the send is in the audit log');

-- A double click, or a retry after a timeout, sends once.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.admin_send_broadcast('00000000-0000-0000-0000-00000000e101', 'Closed today', 'Snow day. Stay home.', 'urgent', '{"type":"class","class_id":"00000000-0000-0000-0000-0000000000c9"}', 'weather', true) ->> 'duplicate', 'true',
  'sending again with the same request id is recognised');
reset role;
select is((select count(*)::int from public.broadcasts), 1, 'and creates nothing');
select is((select count(*)::int from public.notifications where kind = 'broadcast_urgent'), 2, 'or any more notifications');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e101', 'x', 'y', 'notice', '{"type":"everyone"}')$$, '42501', null, 'another administrator cannot reuse that request id');
reset role;

-- A second urgent alert: hand-picked B4 (agreed to texts, has a device) and B2 (no device).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e201', 'Road closed', 'Use the north entrance.', 'urgent',
  '{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b4","00000000-0000-0000-0000-0000000000b2"]}', null, true);
reset role;
select is((select count(*)::int from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Road closed' and d.channel = 'sms' and d.status = 'queued'), 1,
  'the person who agreed to texts has a text queued at once');
select is((select d.destination from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Road closed' and d.channel = 'sms'), '+15555550104', 'to the number they agreed');
select is((select count(*)::int from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Road closed' and d.channel = 'email' and d.status = 'queued'), 2, 'and both are emailed');
select is((select d.reason from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Road closed' and d.channel = 'push'), 'no_device', 'the person with no device is recorded as unreachable by push');

-- Urgent reaches a person in only-urgent mode; a notice does not push to them.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e301', 'Quiet urgent', 'Please read.', 'urgent', '{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b6"]}', null, true);
select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e302', 'Quiet notice', 'FYI.', 'notice', '{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b6"]}');
reset role;
select is((select count(*)::int from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Quiet urgent' and d.channel = 'email'), 1, 'only-urgent mode does not hold back an urgent alert');
select is((select d.reason from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Quiet notice' and d.channel = 'push'), 'quiet_mode', 'but it holds back a notice');
select is((select count(*)::int from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Quiet notice' and d.channel in ('email', 'sms')), 0, 'and queues no email or text for it');

-- The ladder does not send the same urgent alert a second time.
select private.run_notification_ladder(now() + interval '30 hours');
select is((select count(*)::int from (select notification_id, channel from public.notification_deliveries group by 1, 2 having count(*) > 1) x), 0,
  'the ladder adds no second email or text for an alert already sent');

-- ---- rate limits --------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e402', 'Fourth urgent', 'Two.', 'urgent', '{"type":"teachers"}', null, true)$$,
  'P0001', null, 'a fourth urgent alert within the hour is refused');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e403', 'Road closed', 'Use the north entrance.', 'notice', '{"type":"teachers"}')$$,
  'P0001', null, 'a copy of a message sent in the last ten minutes is refused');
select lives_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e404', 'Notice five', 'Five.', 'notice', '{"type":"teachers"}')$$, 'a notice is still allowed');
select lives_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e405', 'Notice six', 'Six.', 'notice', '{"type":"teachers"}')$$, 'up to six in the hour');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e406', 'Notice seven', 'Seven.', 'notice', '{"type":"teachers"}')$$,
  'P0001', null, 'and then none');
reset role;

-- ---- blocks ------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.broadcast_recipients r join public.broadcasts b on b.id = r.broadcast_id where b.title = 'Notice five' and r.user_id = '00000000-0000-0000-0000-0000000000b5'), 0, 'sanity: the blocker was not in the teachers audience');
select is(pg_temp.audience('{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b5"]}', 'notice'), '', 'a notice does not go to someone who blocked the sender');
select is(pg_temp.audience('{"type":"people","user_ids":["00000000-0000-0000-0000-0000000000b5"]}', 'urgent'), 'b5', 'an urgent alert does');

select set_config('t.closed', (select id::text from public.broadcasts where title = 'Closed today'), false);
-- ---- the family side: "Got it" ------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.my_active_urgent_broadcasts()), 1, 'a recipient sees the active urgent alert');
select is((select title from public.my_active_urgent_broadcasts()), 'Closed today', 'with its title');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.my_active_urgent_broadcasts() where title = 'Closed today'), 0, 'someone it was not sent to does not see it');
select throws_ok($$select public.acknowledge_broadcast(current_setting('t.closed')::uuid)$$, '42501', null, 'and cannot acknowledge it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.acknowledge_broadcast(current_setting('t.closed')::uuid)$$, 'a recipient can tap Got it');
select is((select count(*)::int from public.my_active_urgent_broadcasts()), 0, 'and it is gone for them');
select lives_ok($$select public.acknowledge_broadcast(current_setting('t.closed')::uuid)$$, 'tapping again is harmless');
reset role;
select ok((select read_at is not null from public.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000b1' and kind = 'broadcast_urgent'), 'Got it also clears it from the bell');
select is((select count(*)::int from public.broadcast_acks), 1, 'one acknowledgement is stored');

-- T1 still sees it; ending the alert removes it for them; a lapsed alert is not shown.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.my_active_urgent_broadcasts() where title = 'Closed today'), 1, 'a recipient who has not tapped still sees it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_end_broadcast((select id from public.broadcasts where title = 'Closed today'))$$, 'an administrator can end the alert');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.my_active_urgent_broadcasts() where title = 'Closed today'), 0, 'which removes it for those who had not tapped');
reset role;
update public.broadcasts set active_until = now() - interval '1 minute' where title = 'Quiet urgent';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b6","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.my_active_urgent_broadcasts() where title = 'Quiet urgent'), 0, 'an alert past its time stops showing');
reset role;

-- ---- the report ---------------------------------------------------------------------------------------------------------------------------
update public.notification_deliveries set status = 'sent' where notification_id = (select notification_id from public.broadcast_recipients r join public.broadcasts b on b.id = r.broadcast_id where b.title = 'Closed today' and r.user_id = '00000000-0000-0000-0000-0000000000b1') and channel = 'email';
update public.notification_deliveries set status = 'failed', reason = 'send_failed' where notification_id = (select notification_id from public.broadcast_recipients r join public.broadcasts b on b.id = r.broadcast_id where b.title = 'Closed today' and r.user_id = '00000000-0000-0000-0000-0000000000c1') and channel = 'email';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
create temp table rp as select public.admin_broadcast_report((select id from public.broadcasts where title = 'Closed today')) as j;
reset role;
select is((select j ->> 'recipients' from rp), '2', 'the report counts the recipients');
select is((select j ->> 'reached' from rp), '1', 'one reached (tapped Got it and was emailed)');
select is((select j ->> 'not_reached' from rp), '1', 'one not reached: the failed email');
select is((select j ->> 'acked' from rp), '1', 'and the administrator sees how many tapped Got it');
select is((select j -> 'people' -> 0 ->> 'name' from rp), 't1', 'people not reached are listed first');
select is((select j -> 'channels' -> 'email' ->> 'sent' from rp), '1', 'with a count by channel');
select is((select j -> 'channels' -> 'email' ->> 'failed' from rp), '1', 'including failures');
select ok((select (j ->> 'active')::boolean = false from rp), 'and whether the alert is still showing');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select reached from public.admin_broadcast_history(10) where title = 'Closed today'), 1::bigint, 'the history shows reached');
select is((select acked from public.admin_broadcast_history(10) where title = 'Closed today'), 1::bigint, 'and acknowledged');
select is((select count(*)::int from public.admin_broadcast_history(10)), 6, 'newest first, all of them');
reset role;

-- ---- templates ---------------------------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.broadcast_templates where builtin), 3, 'weather closure, schedule change and other are built in');
select is((select severity from public.broadcast_templates where name = 'Weather closure'), 'urgent', 'the weather closure template is urgent');
select lives_ok($$select public.admin_save_broadcast_template('Late start', 'important', 'Late start', 'We start an hour late.')$$, 'an administrator can save a template');
select lives_ok($$select public.admin_delete_broadcast_template((select id from public.broadcast_templates where name = 'Weather closure'))$$, 'deleting a built-in one is a no-op');
select is((select count(*)::int from public.broadcast_templates where builtin), 3, 'it is still there');
select lives_ok($$select public.admin_delete_broadcast_template((select id from public.broadcast_templates where name = 'Late start'))$$, 'a saved one can be deleted');
select is((select count(*)::int from public.broadcast_templates), 3, 'leaving the built-ins');
reset role;

-- ---- second factor -----------------------------------------------------------------------------------------------------------------------------------
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a2', 'totp', 'verified', now(), now());
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_broadcast_preview('{"type":"everyone"}', 'notice')$$, '42501', null, 'an administrator who has not completed two-factor cannot preview');
select throws_ok($$select public.admin_send_broadcast('00000000-0000-0000-0000-00000000e501', 'Hi', 'Hi', 'notice', '{"type":"teachers"}')$$, '42501', null, 'or send');
reset role;

select * from finish();
rollback;
