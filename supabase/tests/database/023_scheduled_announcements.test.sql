-- Scheduled announcements: a post written now goes out later, exactly once, and nothing
-- reaches anyone before then.
-- Fixtures: A1 and A2 active administrators; A3 an administrator who is deactivated later;
-- T teacher of C1; P1 parent in C1; P3 parent not in C1; X an inactive account.
begin;
select plan(74);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'teacher@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b9', 'inactive@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@t.test' and email <> 'inactive@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin'),
  ('00000000-0000-0000-0000-0000000000a4', 'teacher'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'),
  ('00000000-0000-0000-0000-0000000000b9', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f3', 'Three');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b3', 'Parent');
insert into public.children (id, family_id, first_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1', 'K1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000f3', 'K3');
insert into public.classes (id, title, grades, active) values ('00000000-0000-0000-0000-0000000000d1', 'Class One', '{}', true);
insert into public.teacher_assignments (class_id, user_id, assignment_role) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a4', 'lead');
insert into public.enrollments (class_id, child_id, status) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active');

-- ---- the schedule exists --------------------------------------------------------------------
select is((select schedule from cron.job where jobname = 'publish-scheduled-posts'), '* * * * *', 'the publisher runs every minute');

-- ---- who may schedule ---------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_scheduled_post(null, 'Nope', 'x', 'families', null, now() + interval '2 hours')$$, '42501', 'Administrator access is required.', 'a parent cannot schedule a post');
select throws_ok($$insert into public.posts (author_user_id, title, body, audience, scheduled_for) values ('00000000-0000-0000-0000-0000000000b1', 'Sneaky', 'x', 'families', now() + interval '2 hours')$$, '42501', null, 'nor write one straight into the table');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_scheduled_post(null, 'Nope', 'x', 'class', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 hours')$$, '42501', 'Administrator access is required.', 'a teacher cannot schedule one, even for their own class');
select throws_ok($$select public.admin_publish_post_now(gen_random_uuid())$$, '42501', 'Administrator access is required.', 'or publish one');
select throws_ok($$select public.admin_cancel_scheduled_post(gen_random_uuid())$$, '42501', 'Administrator access is required.', 'or cancel one');
reset role;
set local role anon;
select throws_ok($$select public.admin_save_scheduled_post(null, 'Nope', 'x', 'families', null, now() + interval '2 hours')$$, '42501', null, 'someone signed out cannot call it at all');
reset role;

-- ---- scheduling -----------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_save_scheduled_post(null, 'Late', 'x', 'families', null, now() - interval '1 minute')$$, 'P0001', 'Choose a time in the future.', 'a time in the past is refused');
select throws_ok($$select public.admin_save_scheduled_post(null, 'Far', 'x', 'families', null, now() + interval '2 years')$$, 'P0001', 'Choose a time within the next year.', 'so is one more than a year away');
select throws_ok($$select public.admin_save_scheduled_post(null, '  ', 'x', 'families', null, now() + interval '2 hours')$$, 'P0001', 'Give the post a headline.', 'a headline is required');
select throws_ok($$select public.admin_save_scheduled_post(null, 'Class', 'x', 'class', null, now() + interval '2 hours')$$, 'P0001', 'Choose which class this is for.', 'a class post needs its class');
select throws_ok($$insert into public.posts (author_user_id, title, body, audience, scheduled_for) values ('00000000-0000-0000-0000-0000000000a1', 'Late', 'x', 'families', now() - interval '1 hour')$$, 'P0001', 'Choose a time in the future.', 'writing a past time straight into the table is refused too');
select set_config('test.p1', public.admin_save_scheduled_post(null, 'Picture day', '<p>Wear <b>blue</b>.</p>', 'families', null, now() + interval '2 hours')::text, true);
select throws_ok($$update public.posts set scheduled_for = now() - interval '1 hour' where id = current_setting('test.p1')::uuid$$, 'P0001', 'Choose a time in the future.', 'and moving a schedule into the past is refused');
reset role;

select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid and published_at is null and scheduled_for > now() and scheduled_by = '00000000-0000-0000-0000-0000000000a1' and author_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'the post is saved as scheduled, not published');
select is((select count(*)::int from public.audit_log where action = 'news_scheduled' and subject_id = current_setting('test.p1') and actor_user_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'scheduling is written to the audit log');

-- Attach a file now, as the news tab does: it must stay hidden too.
insert into public.post_attachments (post_id, storage_path, file_name) values (current_setting('test.p1')::uuid, 'news/picture.pdf', 'picture.pdf');

-- ---- invisible and silent until it is due ---------------------------------------------------------
select is((select count(*)::int from public.messages where post_id = current_setting('test.p1')::uuid), 0, 'no #Announcements message yet');
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.p1')::uuid), 0, 'no notification yet');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid), 0, 'a parent cannot see it');
select is((select count(*)::int from public.post_attachments where post_id = current_setting('test.p1')::uuid), 0, 'or its attachment');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid), 0, 'a teacher cannot see it');
reset role;
set local role anon;
select is((select count(*)::int from public.posts where title = 'Picture day'), 0, 'the public site cannot see it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid), 1, 'an administrator can see it');
reset role;

select is((private.publish_due_posts(now() + interval '1 hour') ->> 'published')::int, 0, 'the publisher leaves it alone before its time');
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid and published_at is null), 1, 'still scheduled');

-- ---- editing and cancelling -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_scheduled_post(current_setting('test.p1')::uuid, 'Picture day (moved)', '<p>Wear <b>blue</b>.</p>', 'families', null, now() + interval '3 hours')$$, 'another administrator can change the time and the headline');
reset role;
select is((select title || '|' || scheduled_by::text || '|' || author_user_id::text from public.posts where id = current_setting('test.p1')::uuid),
  'Picture day (moved)|00000000-0000-0000-0000-0000000000a2|00000000-0000-0000-0000-0000000000a1', 'the schedule is theirs now, the author is unchanged');
select is((select detail -> 'changed' from public.audit_log where action = 'news_schedule_edited' and subject_id = current_setting('test.p1')), '["headline", "time"]'::jsonb, 'the edit is audited with what changed');
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid and scheduled_for > now() + interval '2 hours 30 minutes'), 1, 'the new time stuck');
select is((private.publish_due_posts(now() + interval '2 hours 30 minutes') ->> 'published')::int, 0, 'the old time no longer publishes it');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.p2', public.admin_save_scheduled_post(null, 'Cancelled news', 'x', 'families', null, now() + interval '2 hours')::text, true);
select lives_ok($$select public.admin_cancel_scheduled_post(current_setting('test.p2')::uuid)$$, 'an administrator can cancel a scheduled post');
select throws_ok($$select public.admin_cancel_scheduled_post(current_setting('test.p2')::uuid)$$, 'P0001', 'That post is not scheduled.', 'cancelling twice says so');
reset role;
select is((select count(*)::int from public.posts where id = current_setting('test.p2')::uuid and published_at is null and scheduled_for is null), 1, 'it is kept as a draft');
select is((select count(*)::int from public.audit_log where action = 'news_schedule_cancelled' and subject_id = current_setting('test.p2')), 1, 'cancelling is audited');
select is((private.publish_due_posts(now() + interval '5 hours') ->> 'published')::int, 1, 'at the due time the publisher sends the scheduled post and not the cancelled one');
select is((select count(*)::int from public.posts where id = current_setting('test.p2')::uuid and published_at is null), 1, 'the cancelled post never goes out');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_scheduled_post(current_setting('test.p2')::uuid, 'Cancelled news', 'x', 'families', null, now() + interval '6 hours')$$, 'a cancelled post can be scheduled again');
select throws_ok($$select public.admin_save_scheduled_post(current_setting('test.p1')::uuid, 'Too late', 'x', 'families', null, now() + interval '9 hours')$$, 'P0001', 'That post has already gone out. Edit it from the news list.', 'a post that has gone out cannot be rescheduled');
reset role;
select is((select count(*)::int from public.audit_log where action = 'news_scheduled' and subject_id = current_setting('test.p2')), 2, 'which counts as scheduling again');

-- ---- going out, once ------------------------------------------------------------------------------------
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid and published_at is not null), 1, 'the first post went out');
select is((select count(*)::int from public.messages where post_id = current_setting('test.p1')::uuid and conversation_id = (select id from public.conversations where system_key = 'announcements')), 1, 'its card is in #Announcements');
select is((select array_agg(recipient_user_id order by recipient_user_id)::text from public.notifications where subject_id = current_setting('test.p1')::uuid and kind = 'post_published'),
  '{00000000-0000-0000-0000-0000000000a2,00000000-0000-0000-0000-0000000000a3,00000000-0000-0000-0000-0000000000a4,00000000-0000-0000-0000-0000000000b1,00000000-0000-0000-0000-0000000000b3}',
  'everyone active was notified except its author and the inactive account');
select is((select count(*)::int from public.audit_log where action = 'news_published' and subject_id = current_setting('test.p1') and detail ->> 'by' = 'schedule' and actor_user_id = '00000000-0000-0000-0000-0000000000a2'), 1, 'publishing is audited as the schedule''s doing, in the name of the person who set it');

select is((private.publish_due_posts(now() + interval '5 hours') ->> 'published')::int, 0, 'a second run publishes nothing');
select is((select count(*)::int from public.messages where post_id = current_setting('test.p1')::uuid), 1, 'and adds no second card');
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.p1')::uuid), 5, 'or second notification');
update public.posts set published_at = now() + interval '1 minute' where id = current_setting('test.p1')::uuid;
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.p1')::uuid), 5, 'even touching published_at again does not notify twice');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.posts where id = current_setting('test.p1')::uuid), 1, 'now a parent can see it');
select is((select count(*)::int from public.post_attachments where post_id = current_setting('test.p1')::uuid), 1, 'and its attachment');
reset role;

select is((select count(*)::int from public.audit_log where action = 'news_published' and subject_id = current_setting('test.p1')), 1, 'one publish record');

-- ---- who it reaches: class posts ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select public.open_class_conversation('00000000-0000-0000-0000-0000000000d1');
select set_config('test.p3', public.admin_save_scheduled_post(null, 'Reading list', 'See attached', 'class', '00000000-0000-0000-0000-0000000000d1', now() + interval '8 hours')::text, true);
reset role;
select is((private.publish_due_posts(now() + interval '9 hours') ->> 'published')::int, 2, 'a class post goes out at its time, along with the rescheduled one that was also due');
select is((select array_agg(recipient_user_id order by recipient_user_id)::text from public.notifications where subject_id = current_setting('test.p3')::uuid),
  '{00000000-0000-0000-0000-0000000000a4,00000000-0000-0000-0000-0000000000b1}', 'to that class''s teacher and family only');
select is((select count(*)::int from public.messages m join public.conversations c on c.id = m.conversation_id where m.post_id = current_setting('test.p3')::uuid and c.class_id = '00000000-0000-0000-0000-0000000000d1'), 1, 'and lands in that class''s channel');

-- ---- publish now, and drafts --------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.p4', public.admin_save_scheduled_post(null, 'Early bird', 'x', 'teachers', null, now() + interval '20 hours')::text, true);
select lives_ok($$select public.admin_publish_post_now(current_setting('test.p4')::uuid)$$, 'an administrator can publish a scheduled post right away');
select throws_ok($$select public.admin_publish_post_now(current_setting('test.p4')::uuid)$$, 'P0001', 'That post has already gone out.', 'but not twice');
reset role;
select is((select array_agg(recipient_user_id)::text from public.notifications where subject_id = current_setting('test.p4')::uuid), '{00000000-0000-0000-0000-0000000000a4}', 'a teaching-team post notified the teacher, once');
select is((select count(*)::int from public.audit_log where action = 'news_published' and subject_id = current_setting('test.p4') and detail ->> 'by' = 'administrator'), 1, 'publishing by hand is audited');
select is((private.publish_due_posts(now() + interval '21 hours') ->> 'published')::int, 0, 'and the publisher does not send it again at its old time');

insert into public.posts (author_user_id, title, body, audience) values ('00000000-0000-0000-0000-0000000000a1', 'Plain draft', 'Not yet', 'families');
select is((select count(*)::int from public.notifications where title = 'Plain draft'), 0, 'a draft notifies no one');
update public.posts set published_at = now() where title = 'Plain draft';
select is((select count(*)::int from public.notifications where title = 'Plain draft'), 5, 'until it is published, which is the one time it does');

insert into public.posts (author_user_id, title, body, audience, published_at) values ('00000000-0000-0000-0000-0000000000a1', 'Right now', 'x', 'families', now());
select is((select count(*)::int from public.notifications where title = 'Right now'), 5, 'a post published at once still notifies at once, as before');

-- ---- a scheduler who is no longer an administrator -----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.p5', public.admin_save_scheduled_post(null, 'From a departing board member', 'x', 'families', null, now() + interval '30 hours')::text, true);
reset role;
update public.profiles set status = 'suspended' where id = '00000000-0000-0000-0000-0000000000a3';
select is((private.publish_due_posts(now() + interval '31 hours') ->> 'held')::int, 1, 'if the person who scheduled it is no longer an active administrator, the post is held');
select is((select count(*)::int from public.posts where id = current_setting('test.p5')::uuid and published_at is null and schedule_held_reason = 'scheduler_unavailable'), 1, 'it stays unpublished and says why');
select is((select count(*)::int from public.messages where post_id = current_setting('test.p5')::uuid) + (select count(*)::int from public.notifications where subject_id = current_setting('test.p5')::uuid and kind = 'post_published'), 0, 'nothing went out');
select is((select array_agg(recipient_user_id order by recipient_user_id)::text from public.notifications where subject_id = current_setting('test.p5')::uuid and kind = 'post_held'),
  '{00000000-0000-0000-0000-0000000000a1,00000000-0000-0000-0000-0000000000a2}', 'the active administrators are told');
select is((select count(*)::int from public.audit_log where action = 'news_schedule_held' and subject_id = current_setting('test.p5')), 1, 'the hold is audited');
select is((private.publish_due_posts(now() + interval '32 hours') ->> 'held')::int, 0, 'the next run does not hold it again, or tell anyone again');
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.p5')::uuid and kind = 'post_held'), 2, 'still two notices');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_save_scheduled_post(current_setting('test.p5')::uuid, 'From a departing board member', 'x', 'families', null, now() + interval '40 hours')$$, 'an administrator can reschedule a held post');
reset role;
select is((select count(*)::int from public.posts where id = current_setting('test.p5')::uuid and schedule_held_reason is null and scheduled_by = '00000000-0000-0000-0000-0000000000a1'), 1, 'which clears the hold and makes it theirs');
select is((private.publish_due_posts(now() + interval '41 hours') ->> 'published')::int, 1, 'and it goes out at the new time');

-- A scheduler whose account is gone altogether (their reference is set to null on deletion).
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.p6', public.admin_save_scheduled_post(null, 'From a removed account', 'x', 'families', null, now() + interval '50 hours')::text, true);
reset role;
update public.posts set scheduled_by = null, author_user_id = null where id = current_setting('test.p6')::uuid;
select is((private.publish_due_posts(now() + interval '51 hours') ->> 'held')::int, 1, 'a post whose scheduler''s account was removed is held too');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_publish_post_now(current_setting('test.p6')::uuid)$$, 'and an administrator can still publish it');
reset role;
select is((select count(*)::int from public.notifications where subject_id = current_setting('test.p6')::uuid and kind = 'post_published'), 5, 'everyone active hears about a post with no author (it used to notify nobody)');

-- ---- an administrator's own schedule held through demotion ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select set_config('test.p7', public.admin_save_scheduled_post(null, 'Demoted admin', 'x', 'families', null, now() + interval '60 hours')::text, true);
reset role;
delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a2' and role = 'admin';
select is((private.publish_due_posts(now() + interval '61 hours') ->> 'held')::int, 1, 'someone who stopped being an administrator also holds back their own scheduled posts');

select * from finish();
rollback;
