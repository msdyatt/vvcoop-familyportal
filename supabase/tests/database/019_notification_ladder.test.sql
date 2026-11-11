-- Notification fallback ladder: preferences, text-message consent, the delivery log, who is
-- queued when, that running it twice changes nothing, and that every rule is checked again at
-- the moment of sending. Nobody who is inactive, a reviewer (demo) account, or has switched a
-- channel off is ever queued.
begin;
select plan(114);

-- A1 administrator. P1 has a phone with the app, P2 has no device, P3 has push switched off,
-- P4 has a device but email switched off, P5 has a device and agreed to texts, P6 is a reviewer
-- account, P7 is suspended, P8 is in quiet mode, P9 has no device and agreed to texts.
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b4', 'p4@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b5', 'p5@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b6', 'p6@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b7', 'p7@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b8', 'p8@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b9', 'p9@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active' where email like '%@t.test';
update public.profiles set status = 'suspended' where email = 'p7@t.test';
update public.profiles set is_demo = true where email = 'p6@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent');

-- Devices: P1, P3, P4, P5, P6, P7, P8 have one.
insert into public.push_subscriptions (user_id, platform, device_token)
select u.id, 'ios', 'token-' || u.email from auth.users u
where u.email in ('p1@t.test', 'p3@t.test', 'p4@t.test', 'p5@t.test', 'p6@t.test', 'p7@t.test', 'p8@t.test');

-- Preferences set directly (the functions are tested below).
insert into public.notification_preferences (user_id, push_enabled) values ('00000000-0000-0000-0000-0000000000b3', false);
insert into public.notification_preferences (user_id, email_enabled) values ('00000000-0000-0000-0000-0000000000b4', false);
insert into public.notification_preferences (user_id, quiet_mode) values ('00000000-0000-0000-0000-0000000000b8', true);
insert into public.notification_preferences (user_id, sms_enabled, sms_phone, sms_consent_at, sms_consent_method, sms_consent_wording) values
  ('00000000-0000-0000-0000-0000000000b5', true, '+15555550105', now() - interval '3 days', 'account_settings_checkbox', 'v1'),
  ('00000000-0000-0000-0000-0000000000b9', true, '+15555550109', now() - interval '3 days', 'account_settings_checkbox', 'v1');

-- ---- phone numbers and the consent rule -------------------------------------------
select is(private.normalize_phone('(555) 555-0123'), '+15555550123', 'a ten-digit US number gets +1');
select is(private.normalize_phone('1-555-555-0123'), '+15555550123', 'so does an eleven-digit one starting with 1');
select is(private.normalize_phone('+44 20 7946 0958'), '+442079460958', 'an international number keeps its own code');
select is(private.normalize_phone('12345'), null, 'a number too short to be real is refused');
select is(private.normalize_phone('(055) 555-0123'), null, 'and so is one with an impossible area code');

select throws_ok($$insert into public.notification_preferences (user_id, sms_enabled) values ('00000000-0000-0000-0000-0000000000a1', true)$$,
  '23514', null, 'text messages cannot be switched on without a number and a recorded agreement');
select throws_ok($$update public.notification_preferences set sms_enabled = true where user_id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'nor by updating an existing row');
select throws_ok($$insert into public.notification_preferences (user_id, sms_phone) values ('00000000-0000-0000-0000-0000000000a1', '5555550123')$$,
  '23514', null, 'a number must be stored in international form');

-- ---- a person's own preferences ----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select push_enabled and email_enabled and not sms_enabled and not quiet_mode from public.my_notification_preferences()), true,
  'with nothing saved the defaults are push on, email on, texts off');
select lives_ok($$select public.set_my_notification_preferences(true, false, true)$$, 'a person can save their preferences');
select is((select email_enabled from public.my_notification_preferences()), false, 'and read them back');
select throws_ok($$update public.notification_preferences set sms_enabled = true where user_id = '00000000-0000-0000-0000-0000000000b1'$$,
  '42501', null, 'preferences cannot be written directly');
select is((select count(*)::int from public.notification_preferences), 1, 'a person sees only their own preferences row');
select lives_ok($$select public.set_my_notification_preferences(true, true, false)$$, 'and can change them back');

-- ---- agreeing to texts ---------------------------------------------------------------
select throws_ok($$select public.set_my_sms_consent('not a number', true)$$, 'P0001', null, 'agreeing with an invalid number is refused');
select is((select count(*)::int from public.sms_consent_log where user_id = '00000000-0000-0000-0000-0000000000b1'), 0,
  'and nothing is recorded for it');
select lives_ok($$select public.set_my_sms_consent('(555) 555-0101', true)$$, 'agreeing with a valid number works');
select is((select sms_phone from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b1'), '+15555550101',
  'the number is stored in international form');
select is((select sms_consent_method from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b1'), 'account_settings_checkbox',
  'how they agreed is recorded');
select ok((select sms_consent_at is not null and sms_consent_wording = 'v1' from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b1'),
  'with the time and the version of the wording');
select ok((select wording like '%Reply STOP%' and action = 'opt_in' and phone = '+15555550101' from public.sms_consent_log where user_id = '00000000-0000-0000-0000-0000000000b1'),
  'the log keeps the exact words they agreed to');
select is((select count(*)::int from public.sms_consent_log), 1, 'and a person sees only their own consent log');
select lives_ok($$select public.set_my_sms_consent(null, false)$$, 'withdrawing works');
select ok((select not sms_enabled and sms_opted_out_at is not null from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b1'),
  'texts are off and the time is kept');
select is((select count(*)::int from public.sms_consent_log where action = 'opt_out'), 1, 'the withdrawal is logged');
select lives_ok($$select public.set_my_sms_consent('(555) 555-0101', true)$$, 'agreeing again after withdrawing works');
select ok((select sms_enabled and sms_opted_out_at is null from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b1'),
  'and clears the opt-out');
select lives_ok($$select public.set_my_sms_consent(null, false)$$, 'switched off again for the tests below');
reset role;

set local role anon;
select throws_ok($$select public.set_my_sms_consent('(555) 555-0101', true)$$, '42501', null, 'a signed-out visitor cannot record consent');
select throws_ok($$select * from public.my_notification_preferences()$$, '42501', null, 'or read preferences');
reset role;

-- ---- the texting provider reports a STOP ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.record_sms_opt_out('+15555550105')$$, '42501', null, 'a signed-in person cannot report a STOP for anyone');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select is(public.record_sms_opt_out('(555) 555-0105'), 1, 'a STOP switches off the person who owns that number');
select is(public.record_sms_opt_out('(555) 555-0199'), 0, 'a number nobody agreed with changes nothing');
reset role;
select ok((select not sms_enabled and sms_opted_out_at is not null from public.notification_preferences where user_id = '00000000-0000-0000-0000-0000000000b5'),
  'after a STOP the person is opted out');
select is((select method from public.sms_consent_log where user_id = '00000000-0000-0000-0000-0000000000b5' and action = 'opt_out'), 'stop_reply',
  'and the log says it was a STOP reply');
-- Put P5 back to agreed for the ladder tests (a fresh agreement, as it would really happen).
update public.notification_preferences set sms_enabled = true, sms_opted_out_at = null, sms_consent_at = now() - interval '2 days' where user_id = '00000000-0000-0000-0000-0000000000b5';

-- ---- who can be reached ----------------------------------------------------------------------
select ok((select push_ok and email_ok and not sms_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b1']::uuid[])),
  'a person with a device and no choices made can be pushed and emailed, not texted');
select ok((select not push_ok and not has_device and email_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b2']::uuid[])),
  'someone without the app can only be emailed');
select ok((select not push_ok and has_device from private.channel_access(array['00000000-0000-0000-0000-0000000000b3']::uuid[])),
  'push switched off means no push even with a device');
select ok((select not email_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b4']::uuid[])), 'email switched off means no email');
select ok((select not active and not push_ok and not email_ok and not sms_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b6']::uuid[])),
  'a reviewer (demo) account is reachable on no channel');
select ok((select not active and not push_ok and not email_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b7']::uuid[])),
  'neither is a suspended profile');
select ok((select not sms_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b5']::uuid[])),
  'an agreed number is still not texted while the master switch is off');

-- ---- the ladder: email --------------------------------------------------------------------------
-- A notification made 25 hours ago, one made an hour ago, and one routine one, for everybody.
insert into public.notifications (id, recipient_user_id, kind, title, body, created_at)
select gen_random_uuid(), u.id, 'broadcast_important', 'Old: ' || u.email, 'x', now() - interval '25 hours' from auth.users u where u.email like 'p%@t.test';
insert into public.notifications (id, recipient_user_id, kind, title, body, created_at)
select gen_random_uuid(), u.id, 'broadcast_notice', 'Fresh: ' || u.email, 'x', now() - interval '1 hour' from auth.users u where u.email like 'p%@t.test';
insert into public.notifications (id, recipient_user_id, kind, title, body, created_at)
select gen_random_uuid(), u.id, 'message', 'Chat: ' || u.email, 'x', now() - interval '30 hours' from auth.users u where u.email like 'p%@t.test';

create temp table ladder_run as select private.run_notification_ladder(now()) as result;
create function pg_temp.emailed(p_title text) returns boolean language sql as $$
  select exists (select 1 from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                 where d.channel = 'email' and n.title = p_title and d.status = 'queued');
$$;

select ok(pg_temp.emailed('Old: p1@t.test'), 'a push-reachable person unseen for 25 hours is queued for email');
select ok(not pg_temp.emailed('Fresh: p1@t.test'), 'but not at one hour: push gets its day');
select ok(pg_temp.emailed('Fresh: p2@t.test'), 'someone with no device is queued straight away');
select ok(pg_temp.emailed('Fresh: p3@t.test'), 'so is someone who switched push off');
select ok(not pg_temp.emailed('Old: p4@t.test'), 'someone who switched email off is not emailed');
select ok(not pg_temp.emailed('Old: p6@t.test') and not pg_temp.emailed('Fresh: p6@t.test'), 'a reviewer (demo) account is never emailed');
select ok(not pg_temp.emailed('Old: p7@t.test') and not pg_temp.emailed('Fresh: p7@t.test'), 'a suspended profile is never emailed');
select ok(not pg_temp.emailed('Old: p8@t.test'), 'quiet mode keeps routine notifications out of email');
select ok(not exists (select 1 from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.kind = 'message'),
  'routine kinds that are not on the fallback list are never queued');
select is((select destination from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Old: p1@t.test' and d.channel = 'email'),
  'p1@t.test', 'the address used is kept on the row');
select is((select count(*)::int from public.notification_deliveries where channel = 'sms'), 0, 'no texts are queued while the master switch is off');

-- Idempotent: the same run again adds nothing.
create temp table before_count as select count(*)::int as n from public.notification_deliveries;
select is(private.run_notification_ladder(now()) ->> 'queued', '0', 'running the ladder again queues nothing');
select is((select count(*)::int from public.notification_deliveries), (select n from before_count), 'and the log is unchanged');
select is((select count(*)::int from (select notification_id, channel from public.notification_deliveries group by 1, 2 having count(*) > 1) x), 0,
  'no notification has two rows for one channel');

-- Seen means stop.
insert into public.notifications (id, recipient_user_id, kind, title, created_at, read_at) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', 'broadcast_important', 'Read: p2', now() - interval '30 hours', now() - interval '29 hours');
insert into public.notifications (id, recipient_user_id, kind, title, created_at, push_opened_at) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2', 'broadcast_important', 'Tapped: p2', now() - interval '30 hours', now() - interval '29 hours');
select private.run_notification_ladder(now());
select ok(not pg_temp.emailed('Read: p2'), 'a notification read in the bell is not emailed');
select ok(not pg_temp.emailed('Tapped: p2'), 'nor one whose push was tapped');

-- Push that failed does not get a day's grace.
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'broadcast_important', 'Pushfail: p1', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b1', 'broadcast_important', 'Pushok: p1', now() - interval '10 minutes');
insert into public.notification_deliveries (notification_id, user_id, channel, status, reason) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'push', 'failed', null),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b1', 'push', 'sent', null);
select private.run_notification_ladder(now());
select ok(pg_temp.emailed('Pushfail: p1'), 'a person whose push failed is emailed at once');
select ok(not pg_temp.emailed('Pushok: p1'), 'a person whose push went through still waits');

-- The wait is a setting.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_update_notification_settings(48, 0, array['broadcast_urgent','broadcast_important'], array['broadcast_urgent','broadcast_important','broadcast_notice'], true, false)$$,
  'an administrator can change the wait');
reset role;
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b1', 'broadcast_important', '30h: p1', now() - interval '30 hours');
select private.run_notification_ladder(now());
select ok(not pg_temp.emailed('30h: p1'), 'with a 48 hour wait a 30 hour old notification is not yet due');
select private.run_notification_ladder(now() + interval '19 hours');
select ok(pg_temp.emailed('30h: p1'), 'and it is once the 48 hours have passed');
update public.notification_settings set fallback_hours = 24;

-- A muted conversation stays muted, even if its kind is on the list.
insert into public.conversations (id, kind, title, created_by) values ('00000000-0000-0000-0000-0000000000d1', 'group', 'Carpool', '00000000-0000-0000-0000-0000000000a1');
insert into public.conversation_members (conversation_id, user_id, muted) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', true),
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b9', false);
update public.notification_settings set email_fallback_kinds = email_fallback_kinds || array['message'];
insert into public.notifications (id, recipient_user_id, kind, title, subject_type, subject_id, created_at) values
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000b2', 'message', 'Muted chat', 'conversation', '00000000-0000-0000-0000-0000000000d1', now() - interval '30 hours'),
  ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000b9', 'message', 'Open chat', 'conversation', '00000000-0000-0000-0000-0000000000d1', now() - interval '30 hours');
select private.run_notification_ladder(now());
select ok(not pg_temp.emailed('Muted chat'), 'a muted conversation is not emailed');
select ok(pg_temp.emailed('Open chat'), 'while an unmuted one on the list is');
update public.notification_settings set email_fallback_kinds = array['broadcast_urgent','broadcast_important','broadcast_notice'];

-- Urgent ignores quiet mode.
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000c8', '00000000-0000-0000-0000-0000000000b8', 'broadcast_urgent', 'Urgent: p8', now() - interval '1 minute'),
  ('00000000-0000-0000-0000-0000000000c9', '00000000-0000-0000-0000-0000000000b8', 'broadcast_urgent', 'Urgent old: p8', now() - interval '26 hours');
select private.run_notification_ladder(now());
select ok(pg_temp.emailed('Urgent old: p8'), 'an urgent alert reaches a person in quiet mode');

-- ---- the ladder: text ------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_update_notification_settings(24, 0, array['broadcast_urgent','broadcast_important'], array['broadcast_urgent','broadcast_important','broadcast_notice'], true, true)$$,
  'an administrator can switch the texting master switch on');
reset role;
select ok((select sms_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b5']::uuid[])), 'an agreed number can now be texted');
select ok((select not sms_ok from private.channel_access(array['00000000-0000-0000-0000-0000000000b1']::uuid[])), 'a number nobody agreed to still cannot');
select private.run_notification_ladder(now());
create function pg_temp.texted(p_title text) returns boolean language sql as $$
  select exists (select 1 from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                 where d.channel = 'sms' and n.title = p_title);
$$;
select ok(pg_temp.texted('Old: p5@t.test'), 'a person who agreed is texted for an important notification unseen past the wait');
select ok(not pg_temp.texted('Fresh: p5@t.test'), 'but not for a notice (not on the important list)');
select ok(not pg_temp.texted('Old: p1@t.test'), 'a person who never agreed is never texted');
select ok(pg_temp.texted('Fresh: p9@t.test') is false and pg_temp.texted('Old: p9@t.test'),
  'an agreed person with no device is texted for important ones straight away, not for notices');
select ok(not pg_temp.texted('Old: p6@t.test') and not pg_temp.texted('Old: p7@t.test'), 'reviewer and suspended profiles are not texted');
select is((select destination from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.title = 'Old: p5@t.test' and d.channel = 'sms'),
  '+15555550105', 'the number is kept on the row');
select ok(not exists (select 1 from public.notification_deliveries d join auth.users u on u.id = d.user_id
  where d.channel = 'sms' and not exists (select 1 from public.sms_consent_log l where l.user_id = d.user_id) and u.email not in ('p5@t.test', 'p9@t.test')),
  'every text queued belongs to a person with a recorded agreement');

-- ---- sending: every rule is checked again --------------------------------------------------------
-- Queue a fresh pair for P5 and check each rule against it.
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b5', 'broadcast_important', 'Claim A', now() - interval '26 hours'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b5', 'broadcast_important', 'Claim B', now() - interval '26 hours'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000b5', 'broadcast_important', 'Claim C', now() - interval '26 hours');
select private.run_notification_ladder(now());
-- B is read, C has its agreement withdrawn, between queueing and sending.
update public.notifications set read_at = now() where id = '00000000-0000-0000-0000-0000000000e2';
-- Clear the rows made earlier so the counts below are about these three notifications only.
update public.notification_deliveries set status = 'skipped', reason = 'test_cleanup' where status = 'queued' and notification_id not in
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e3');
update public.notification_deliveries set status = 'skipped', reason = 'test_cleanup' where channel = 'email' and notification_id = '00000000-0000-0000-0000-0000000000e3';
update public.notification_preferences set sms_enabled = false, sms_opted_out_at = now() where user_id = '00000000-0000-0000-0000-0000000000b5';

set local role service_role;
create temp table claimed as select * from public.claim_deliveries(array['email', 'sms'], 100);
reset role;
select is((select count(*)::int from claimed), 1, 'only the notification still unseen and still allowed is handed to the sender');
select is((select title from claimed), 'Claim A', 'it is the right one');
select is((select channel from claimed), 'email', 'by email, as queued');
select is((select status from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e2' and channel = 'email'), 'skipped',
  'one read in the meantime is dropped');
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e2' and channel = 'email'), 'seen_meanwhile',
  'with the reason recorded');
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e3' and channel = 'sms'), 'sms_not_allowed',
  'a text is dropped when the person withdrew their agreement after it was queued');
select is((select status from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e1' and channel = 'email'), 'sending',
  'the claimed row is marked as being sent');
set local role service_role;
select is((select count(*)::int from public.claim_deliveries(array['email', 'sms'], 100)), 0, 'claiming again returns nothing: a row is handed out once');
select lives_ok($$select public.finish_delivery((select delivery_id from claimed), 'sent', null, 'resend', 'msg_123', null, true)$$, 'the sender can report success');
reset role;
select is((select provider_message_id from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e1' and channel = 'email'), 'msg_123',
  'the provider message id is kept');
select ok((select sent_at is not null and status = 'sent' from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e1' and channel = 'email'),
  'with the time it was sent');

-- A stale queued row is not sent late; a phone number that changed is not texted at the old one.
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000b9', 'broadcast_important', 'Stale', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000b9', 'broadcast_important', 'Moved', now() - interval '2 hours');
insert into public.notification_deliveries (notification_id, user_id, channel, status, destination, queued_at) values
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000b9', 'email', 'queued', 'p9@t.test', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-0000000000b9', 'sms', 'queued', '+15555550000', now());
set local role service_role;
select count(*) from public.claim_deliveries(array['email', 'sms'], 100);
reset role;
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e4'), 'expired', 'a row that waited over a day is not sent late');
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e5'), 'phone_changed', 'a text is never sent to a number other than the one agreed');

-- A reviewer or suspended profile with a queued row is dropped at sending time too.
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000b6', 'broadcast_urgent', 'Demo', now());
insert into public.notification_deliveries (notification_id, user_id, channel, status, destination) values
  ('00000000-0000-0000-0000-0000000000e6', '00000000-0000-0000-0000-0000000000b6', 'email', 'queued', 'p6@t.test');
set local role service_role;
select count(*) from public.claim_deliveries(array['email'], 100);
reset role;
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000e6'), 'inactive', 'a reviewer account is dropped even if a row slipped in');

-- ---- retries and interruptions ---------------------------------------------------------------------
insert into public.notifications (id, recipient_user_id, kind, title, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'broadcast_important', 'Retry me', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'broadcast_important', 'Do not retry', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b2', 'broadcast_important', 'Stuck', now() - interval '3 hours');
insert into public.notification_deliveries (notification_id, user_id, channel, attempt, status, retryable, updated_at, destination) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'email', 1, 'failed', true, now() - interval '20 minutes', 'p2@t.test'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b2', 'email', 1, 'failed', false, now() - interval '20 minutes', 'p2@t.test'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b2', 'email', 1, 'sending', true, now() - interval '30 minutes', 'p2@t.test');
select private.run_notification_ladder(now());
select is((select count(*)::int from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000f1' and channel = 'email'), 2,
  'a failed email is tried again');
select is((select count(*)::int from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000f2' and channel = 'email'), 1,
  'unless the failure cannot be fixed by trying again');
select is((select reason from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000f3' and attempt = 1), 'interrupted',
  'a send that never reported back is closed as interrupted');
select private.run_notification_ladder(now());
select is((select count(*)::int from public.notification_deliveries where notification_id = '00000000-0000-0000-0000-0000000000f1' and channel = 'email'), 2,
  'running again does not add a third try while the second is waiting');

-- ---- tapping a push notification counts as seeing it -----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.record_notification_open('00000000-0000-0000-0000-0000000000c3')$$, 'the recipient can record a tap');
reset role;
select ok((select push_opened_at is not null from public.notifications where id = '00000000-0000-0000-0000-0000000000c3'), 'and it is stored');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
set local role authenticated;
select public.record_notification_open('00000000-0000-0000-0000-0000000000c4');
reset role;
select ok((select push_opened_at is null from public.notifications where id = '00000000-0000-0000-0000-0000000000c4'), 'someone else cannot say it was seen');

-- ---- administrators -------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_notification_settings(12, 0, array['broadcast_urgent'], array['broadcast_urgent'], true, false)$$,
  '42501', null, 'a non-administrator cannot change the settings');
select throws_ok($$select * from public.admin_delivery_summary(7)$$, '42501', null, 'or read the delivery summary');
select is((select count(*)::int from public.notification_deliveries), 0, 'or read the delivery log');
select is((select count(*)::int from public.notification_settings), 0, 'or the settings');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_notification_settings(0, 0, array['broadcast_urgent'], array['broadcast_urgent'], true, false)$$,
  'P0001', null, 'a wait of zero hours is refused');
select throws_ok($$select public.admin_update_notification_settings(24, 0, array['Not A Kind!'], array['broadcast_urgent'], true, false)$$,
  'P0001', null, 'a malformed kind is refused');
select lives_ok($$select public.admin_update_notification_settings(36, 2, array['broadcast_urgent'], array['broadcast_urgent','sign_request'], true, false)$$, 'valid settings save');
select is((select fallback_hours from public.notification_settings), 36, 'and are read back');
select ok((select sum(total) > 0 from public.admin_delivery_summary(7)), 'an administrator can see the delivery summary');
select ok((select count(*) > 0 from public.notification_deliveries), 'and the delivery log');
reset role;
select ok(exists (select 1 from public.audit_log where action = 'notification_settings_updated' and actor_user_id = '00000000-0000-0000-0000-0000000000a1'),
  'changing the settings is written to the audit log');

-- An administrator with a second factor set up but not used in this session is refused.
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'totp', 'verified', now(), now());
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_notification_settings(24, 0, array['broadcast_urgent'], array['broadcast_urgent'], true, false)$$,
  '42501', null, 'without the second factor an administrator is refused');
reset role;

-- ---- the schedule and the permissions ----------------------------------------------------------------------------------
select ok(exists (select 1 from cron.job where jobname = 'notification-ladder'), 'the ladder is scheduled');
select ok(exists (select 1 from cron.job where jobname = 'deliver-notifications'), 'and so is the sender');
select ok(not has_function_privilege('authenticated', 'public.claim_deliveries(text[],integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_deliveries(text[],integer)', 'EXECUTE'),
  'only the service role can claim deliveries');
select ok(not has_function_privilege('authenticated', 'public.finish_delivery(uuid,text,text,text,text,text,boolean)', 'EXECUTE'),
  'and report on them');
select ok(not has_function_privilege('authenticated', 'private.run_notification_ladder(timestamptz)', 'EXECUTE'),
  'nobody signed in can run the ladder');

select * from finish();
rollback;
