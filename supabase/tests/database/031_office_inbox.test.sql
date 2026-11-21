-- Shared office inbox: administrators only (second factor when enrolled, never a reviewer
-- account); parents see nothing, notes included; every write goes through a function and
-- writes the history and the activity log; the history is append-only; the token lives in
-- Vault; sends are recorded, limited and never doubled; attachments open only through a
-- short, logged grant.
begin;
select plan(103);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin2@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin'), ('00000000-0000-0000-0000-0000000000b1', 'parent'),
  ('00000000-0000-0000-0000-0000000000c1', 'admin');
-- Since admin permissions (20261121160000), board-only areas need a board admin.
insert into public.admin_tiers (user_id, tier) select user_id, 'board' from public.user_roles where role = 'admin' on conflict do nothing;
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());

insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'The Parent Family');
insert into public.family_members (family_id, user_id, relationship) values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'parent');
insert into public.children (family_id, first_name, age_band) values ('00000000-0000-0000-0000-0000000000f1', 'Pippa', '3');

update public.office_inbox_settings set status = 'connected', mailbox_address = 'office@veritasvillage.org', functions_url = 'https://ref.supabase.co';

-- ---- who may call what ----------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.office_inbox_threads(text,text,text,boolean,text,integer,integer)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.office_inbox_thread(uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.office_inbox_set_status(uuid,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.office_inbox_add_note(uuid,text)', 'EXECUTE'), 'visitors cannot call the inbox');
select ok(not has_function_privilege('authenticated', 'public.office_inbox_import_message(jsonb)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_begin_send(uuid,uuid,text,uuid,text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_finish_send(uuid,boolean,text,text,text,text,text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_save_connection(uuid,text,text,text,text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_clear_connection(uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_begin_oauth(uuid,text,text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_take_oauth(text)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_claim_sync()', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_finish_sync(text,integer,text,boolean,boolean)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.office_inbox_known_messages(text[])', 'EXECUTE'),
          'signed-in people, administrators included, cannot call the functions only the Edge Functions use');
select ok(has_function_privilege('service_role', 'public.office_inbox_import_message(jsonb)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.office_inbox_begin_send(uuid,uuid,text,uuid,text)', 'EXECUTE'), 'the service role can');
select ok(not has_table_privilege('authenticated', 'public.inbox_threads', 'INSERT')
          and not has_table_privilege('authenticated', 'public.inbox_threads', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.inbox_messages', 'INSERT')
          and not has_table_privilege('authenticated', 'public.inbox_notes', 'INSERT')
          and not has_table_privilege('authenticated', 'public.inbox_notes', 'DELETE')
          and not has_table_privilege('authenticated', 'public.inbox_events', 'INSERT')
          and not has_table_privilege('authenticated', 'public.office_inbox_settings', 'UPDATE'), 'nobody writes the inbox tables directly');
select ok(not has_table_privilege('authenticated', 'public.office_inbox_oauth_states', 'SELECT')
          and not has_table_privilege('authenticated', 'public.inbox_sends', 'SELECT')
          and not has_table_privilege('authenticated', 'public.inbox_attachment_grants', 'SELECT')
          and not has_table_privilege('anon', 'public.inbox_messages', 'SELECT'), 'sign-in attempts, sends and file grants are not readable from the browser');
select ok(exists (select 1 from cron.job where jobname = 'office-inbox-sync'), 'the poll is scheduled');
select ok(exists (select 1 from vault.secrets where name = 'OFFICE_INBOX_CRON_SECRET'), 'the poll has its own Vault secret');
select ok((select not public from storage.buckets where id = 'office-inbox'), 'the attachment bucket is private');

-- ---- importing mail (service role) --------------------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temp table imp1 on commit drop as select public.office_inbox_import_message(jsonb_build_object(
  'gmail_message_id', 'g1', 'gmail_thread_id', 'gt1', 'direction', 'inbound', 'from_address', 'Parent@T.test', 'from_name', 'Pat Parent',
  'to', jsonb_build_array('office@veritasvillage.org'), 'subject', 'Field trip receipt', 'sent_at', '2026-11-18T15:00:00Z',
  'rfc_message_id', '<g1@mail.t.test>', 'body_text', 'Here is the receipt for the museum tickets. Pippa loved it.',
  'body_html', '<p>Here is the receipt</p>', 'snippet', 'Here is the receipt', 'category', 'reimbursement',
  'attachments', jsonb_build_array(jsonb_build_object('filename', 'receipt.jpg', 'mime_type', 'image/jpeg', 'size_bytes', 5, 'storage_path', 'messages/g1/0')))) as r;
create temp table imp2 on commit drop as select public.office_inbox_import_message(jsonb_build_object(
  'gmail_message_id', 'g2', 'gmail_thread_id', 'gt2', 'direction', 'inbound', 'from_address', 'stranger@elsewhere.test',
  'subject', 'Do you have space?', 'sent_at', '2026-11-18T16:00:00Z', 'rfc_message_id', '<g2@x>', 'body_text', 'Is there room next year?',
  'category', 'enrollment')) as r;
select is((select r->>'skipped' from (select public.office_inbox_import_message(jsonb_build_object(
  'gmail_message_id', 'g1', 'gmail_thread_id', 'gt1', 'direction', 'inbound', 'from_address', 'parent@t.test')) as r) x), 'known', 'the same message is never imported twice');
select is((select r->>'skipped' from (select public.office_inbox_import_message(jsonb_build_object(
  'gmail_message_id', 'g9', 'gmail_thread_id', 'gt9', 'direction', 'outbound', 'from_address', 'office@veritasvillage.org')) as r) x),
  'outbound_without_thread', 'mail the office sent from Gmail starts no conversation');
reset role;

create temp table th on commit drop as
  select (select (r->>'thread_id')::uuid from imp1) as matched, (select (r->>'thread_id')::uuid from imp2) as stranger;
grant select on th to authenticated, service_role;
select is((select family_id from public.inbox_threads where id = (select matched from th)), '00000000-0000-0000-0000-0000000000f1'::uuid,
  'a sender with a portal account is matched to their household');
select is((select counterpart_email from public.inbox_threads where id = (select matched from th)), 'parent@t.test', 'addresses are kept in lower case');
select ok((select family_id is null and status = 'new' and category = 'enrollment' from public.inbox_threads where id = (select stranger from th)),
  'an unknown sender is a new, unmatched conversation');
select is((select count(*)::int from public.inbox_attachments where thread_id = (select matched from th)), 1, 'attachments are listed');
select ok((select message_count = 1 and has_attachments and last_inbound_at is not null from public.inbox_threads where id = (select matched from th)), 'the thread totals are kept');

-- ---- a parent and a reviewer account see and do nothing -----------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.inbox_threads), 0, 'a parent cannot read the threads, not even their own');
select is((select count(*)::int from public.inbox_messages), 0, 'nor the messages');
select is((select count(*)::int from public.office_inbox_settings), 0, 'nor the connection');
select throws_ok($$select * from public.office_inbox_threads()$$, '42501', 'Administrator access is required.', 'a parent cannot list the inbox');
select throws_ok(format('select public.office_inbox_thread(%L)', (select matched from th)), '42501', 'Administrator access is required.', 'a parent cannot open a thread');
select throws_ok(format('select public.office_inbox_add_note(%L, %L)', (select matched from th), 'hi'), '42501', 'Administrator access is required.', 'a parent cannot add a note');
select throws_ok(format('select public.office_inbox_family_context(%L)', (select matched from th)), '42501', 'Administrator access is required.', 'a parent cannot read the family panel');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.inbox_threads), 0, 'a reviewer account with the admin role reads nothing');
select is((select count(*)::int from public.inbox_messages), 0, 'not even the messages');
select throws_ok($$select * from public.office_inbox_threads()$$, '42501', 'Administrator access is required.', 'a reviewer account cannot list the inbox');
select throws_ok(format('select public.office_inbox_set_status(%L, %L)', (select matched from th), 'done'), '42501', 'Administrator access is required.', 'nor change a status');
reset role;

-- ---- an administrator who has not passed the second factor ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select * from public.office_inbox_threads()$$, '42501', 'Complete two-factor verification before continuing.', 'an administrator at aal1 cannot list the inbox');
select is((select count(*)::int from public.inbox_messages), 0, 'and reads no messages directly');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select count(*)::int from public.office_inbox_threads()), 2, 'once they have, they can');
reset role;

-- ---- an administrator works the inbox ----------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.office_inbox_threads()), 2, 'an administrator sees both threads');
select ok((select bool_and(unread) from public.office_inbox_threads()), 'new mail is unread');
select is((select (public.office_inbox_counts())->>'new'), '2', 'the counts add up');
select is((select jsonb_array_length(public.office_inbox_thread((select matched from th))->'messages')), 1, 'opening a thread shows its messages');
select is((select public.office_inbox_thread((select matched from th))->'thread'->>'reply_to'), 'parent@t.test', 'and where a reply will go');
select ok((select not unread from public.office_inbox_threads() where id = (select matched from th)), 'and marks it read for this administrator');
select ok((select unread from public.office_inbox_threads() where id = (select stranger from th)), 'but not the other thread');
select is((select count(*)::int from public.office_inbox_threads(p_query => 'museum tickets')), 1, 'search finds words in the body');
select is((select count(*)::int from public.office_inbox_threads(p_query => 'elsewhere.test')), 1, 'and the sender''s address');
select is((select count(*)::int from public.office_inbox_threads(p_query => '100%_')), 0, 'and treats wildcards as text');
select is((select count(*)::int from public.office_inbox_threads(p_category => 'reimbursement')), 1, 'filtering by category works');
select throws_ok($$select * from public.office_inbox_threads(p_assignee => 'nonsense')$$, 'P0001', 'Unknown assignee.', 'a bad assignee filter is refused');

select lives_ok(format('select public.office_inbox_set_status(%L, %L)', (select matched from th), 'open'), 'an administrator can change the status');
select lives_ok(format('select public.office_inbox_assign(%L, %L)', (select matched from th), '00000000-0000-0000-0000-0000000000a2'), 'and assign it to another administrator');
select throws_ok(format('select public.office_inbox_assign(%L, %L)', (select matched from th), '00000000-0000-0000-0000-0000000000b1'), 'P0001',
  'Conversations can only be assigned to an administrator.', 'but not to a parent');
select throws_ok(format('select public.office_inbox_assign(%L, %L)', (select matched from th), '00000000-0000-0000-0000-0000000000c1'), 'P0001',
  'Conversations can only be assigned to an administrator.', 'nor to a reviewer account');
select lives_ok(format('select public.office_inbox_set_category(%L, %L)', (select stranger from th), 'concern'), 'and change the category');
select throws_ok(format('select public.office_inbox_set_category(%L, %L)', (select stranger from th), 'gossip'), 'P0001', 'Choose a category.', 'only known categories');
select lives_ok(format('select public.office_inbox_add_note(%L, %L)', (select matched from th), 'Paid back on Friday, cash.'), 'and add an internal note');
select is((select count(*)::int from public.inbox_notes), 1, 'administrators see the note');
select is((select jsonb_array_length(public.office_inbox_thread((select matched from th))->'notes')), 1, 'in the thread');
select is((select count(*)::int from public.office_inbox_admins()), 3, 'only active, non-reviewer administrators can be assigned');
select is((select public.office_inbox_family_context((select matched from th))->'children'->0->>'first_name'), 'Pippa', 'the family panel shows the children');
select is((select public.office_inbox_family_context((select stranger from th))->>'matched'), 'false', 'and says plainly when the sender is unknown');
select lives_ok(format('select public.office_inbox_save_canned(null, %L, %L)', 'Receipt received', 'Thanks, we have your receipt.'), 'canned replies can be saved');
reset role;

select is((select count(*)::int from public.inbox_events where kind = 'status' and actor_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'the status change is in the history');
select is((select count(*)::int from public.inbox_events where kind = 'assigned' and detail->>'to' = '00000000-0000-0000-0000-0000000000a2'), 1, 'and the assignment');
select is((select count(*)::int from public.audit_log where action in ('office_inbox_status', 'office_inbox_assigned', 'office_inbox_category', 'office_inbox_note_added')), 4,
  'and each one in the activity log');
select ok((select not (detail ? 'body') from public.audit_log where action = 'office_inbox_note_added'), 'the note''s text is not copied into the activity log');

-- Notes stay hidden from the parent even now that one exists.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.inbox_notes), 0, 'a parent never sees an internal note');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.inbox_notes), 0, 'nor does a reviewer account');
reset role;

-- The history cannot be rewritten, even by the database owner.
select throws_ok($$update public.inbox_events set kind = 'status'$$, '42501', 'The office inbox history cannot be changed.', 'history rows cannot be changed');
select throws_ok($$delete from public.inbox_events$$, '42501', 'The office inbox history cannot be changed.', 'or removed');

-- ---- attachments open only through a logged grant --------------------------------------------------------------------
insert into storage.objects (bucket_id, name) values ('office-inbox', 'messages/g1/0');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'office-inbox'), 0, 'an administrator cannot read a stored file without opening it');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('office-inbox', 'messages/x/0')$$, '42501', null, 'nobody signed in can store a file there');
select is((select public.office_inbox_open_attachment((select id from public.inbox_attachments limit 1))->>'path'), 'messages/g1/0', 'opening an attachment gives its path');
select is((select count(*)::int from storage.objects where bucket_id = 'office-inbox'), 1, 'and a short grant to read it');
reset role;
select is((select count(*)::int from public.inbox_events where kind = 'attachment_opened'), 1, 'which is logged');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from storage.objects where bucket_id = 'office-inbox'), 0, 'a parent can never read the files');
reset role;

-- ---- sending a reply (service role, for a checked administrator) ----------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
create temp table s1 on commit drop as select public.office_inbox_begin_send('00000000-0000-0000-0000-0000000000a1', (select matched from th),
  'Thanks, Pat. Paid back Friday.', '00000000-0000-0000-0000-00000000aa01') as r;
select is((select r->>'to' from s1), 'parent@t.test', 'a reply goes to the family''s address');
select is((select r->>'in_reply_to' from s1), '<g1@mail.t.test>', 'and threads to their last message');
select is((select r->>'duplicate' from (select public.office_inbox_begin_send('00000000-0000-0000-0000-0000000000a1', (select matched from th),
  'Thanks, Pat. Paid back Friday.', '00000000-0000-0000-0000-00000000aa01') as r) x), 'true', 'the same click twice is one reply');
select throws_ok(format('select public.office_inbox_begin_send(%L, %L, %L, %L)', '00000000-0000-0000-0000-0000000000a1', (select matched from th), 'Again', gen_random_uuid()),
  'P0001', 'A reply to this conversation was sent a moment ago.', 'two different replies seconds apart are refused');
select throws_ok(format('select public.office_inbox_begin_send(%L, %L, %L, %L)', '00000000-0000-0000-0000-0000000000c1', (select stranger from th), 'Hi', gen_random_uuid()),
  '42501', 'Administrator access is required.', 'a reviewer account cannot send');
select throws_ok(format('select public.office_inbox_begin_send(%L, %L, %L, %L)', '00000000-0000-0000-0000-0000000000b1', (select stranger from th), 'Hi', gen_random_uuid()),
  '42501', 'Administrator access is required.', 'nor can a parent');
select lives_ok(format('select public.office_inbox_finish_send(%L, true, %L, %L, %L, %L, null)', (select (r->>'send_id')::uuid from s1),
  'gsent1', '<gsent1@mail.gmail.com>', 'Re: Field trip receipt', '<p>Thanks, Pat.</p>'), 'the sent reply is recorded');
reset role;
select ok((select status = 'waiting' and message_count = 2 from public.inbox_threads where id = (select matched from th)), 'the thread now waits on the family');
select is((select direction || ' ' || sent_by::text from public.inbox_messages where gmail_message_id = 'gsent1'), 'outbound 00000000-0000-0000-0000-0000000000a1', 'with the reply in it, and who sent it');
select is((select count(*)::int from public.inbox_events where kind = 'reply_sent' and actor_id = '00000000-0000-0000-0000-0000000000a1'), 1, 'the send is in the history');
select is((select count(*)::int from public.audit_log where action = 'office_inbox_reply_sent'), 1, 'and in the activity log');

-- The family writes back: the conversation reopens by itself.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select lives_ok($$select public.office_inbox_import_message(jsonb_build_object('gmail_message_id', 'g3', 'gmail_thread_id', 'gt1', 'direction', 'inbound',
  'from_address', 'parent@t.test', 'subject', 'Re: Field trip receipt', 'sent_at', '2026-11-19T10:00:00Z', 'rfc_message_id', '<g3@x>', 'body_text', 'Thank you!'))$$, 'a reply from the family is imported');
reset role;
select is((select status from public.inbox_threads where id = (select matched from th)), 'open', 'and reopens the thread');

-- Limits: 20 an hour for one administrator.
insert into public.inbox_sends (thread_id, sent_by, client_key, to_address, body_text, status, created_at)
select (select stranger from th), '00000000-0000-0000-0000-0000000000a2', gen_random_uuid(), 'x@y.test', 'x', 'sent', now() - interval '5 minutes'
from generate_series(1, 20);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok(format('select public.office_inbox_begin_send(%L, %L, %L, %L)', '00000000-0000-0000-0000-0000000000a2', (select stranger from th), 'One more', gen_random_uuid()),
  'P0001', 'You have sent 20 replies in the last hour. Wait a little before sending more.', 'an administrator is limited to 20 replies an hour');
reset role;

-- A disconnected inbox sends nothing.
update public.office_inbox_settings set status = 'disconnected';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok(format('select public.office_inbox_begin_send(%L, %L, %L, %L)', '00000000-0000-0000-0000-0000000000a1', (select stranger from th), 'Hi', gen_random_uuid()),
  'P0001', 'The office inbox is not connected.', 'nothing is sent while the inbox is disconnected');
reset role;

-- ---- connecting: the sign-in state, the token in Vault, the lease -----------------------------------------------------------
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select throws_ok($$select public.office_inbox_begin_oauth('00000000-0000-0000-0000-0000000000b1', repeat('a', 64), repeat('v', 64))$$, '42501', 'Administrator access is required.',
  'a parent cannot start connecting the mailbox');
select lives_ok($$select public.office_inbox_begin_oauth('00000000-0000-0000-0000-0000000000a1', repeat('a', 64), repeat('v', 64))$$, 'an administrator can');
select is((select public.office_inbox_take_oauth(repeat('a', 64))->>'user_id'), '00000000-0000-0000-0000-0000000000a1', 'the answer is tied to them');
select ok(public.office_inbox_take_oauth(repeat('a', 64)) is null, 'and works only once');
select throws_ok($$select public.office_inbox_save_connection('00000000-0000-0000-0000-0000000000c1', 'office@veritasvillage.org', 'rt', 'Label_1', 'https://ref.supabase.co')$$,
  '42501', 'Administrator access is required.', 'a reviewer account cannot connect the mailbox');
select lives_ok($$select public.office_inbox_save_connection('00000000-0000-0000-0000-0000000000a1', 'Office@VeritasVillage.org', 'refresh-1', 'Label_1', 'https://ref.supabase.co')$$,
  'an administrator''s connection is saved');
select is(public.read_vault_secret('OFFICE_INBOX_REFRESH_TOKEN'), 'refresh-1', 'the refresh token is in Vault');
select is((select status || ' ' || mailbox_address from public.office_inbox_settings), 'connected office@veritasvillage.org', 'and the inbox is connected');
select lives_ok($$select public.office_inbox_save_connection('00000000-0000-0000-0000-0000000000a1', 'office@veritasvillage.org', 'refresh-2', 'Label_1', 'https://ref.supabase.co')$$,
  'reconnecting replaces the token');
select is(public.read_vault_secret('OFFICE_INBOX_REFRESH_TOKEN'), 'refresh-2', 'with only one copy kept');
select ok(public.office_inbox_claim_sync() is not null, 'a sync run takes the lease');
select ok(public.office_inbox_claim_sync() is null, 'and a second run at the same time does nothing');
select lives_ok($$select public.office_inbox_finish_sync('777', 3, null, false)$$, 'a finished run records its outcome');
select is((select history_id || ' ' || last_sync_imported from public.office_inbox_settings), '777 3', 'with the new bookmark');
select lives_ok($$select public.office_inbox_finish_sync(null, 0, 'Google refused', true)$$, 'a refused token');
select is((select status from public.office_inbox_settings), 'attention', 'marks the inbox for attention');
select lives_ok($$select public.office_inbox_clear_connection('00000000-0000-0000-0000-0000000000a1')$$, 'an administrator can disconnect');
select ok(public.read_vault_secret('OFFICE_INBOX_REFRESH_TOKEN') is null, 'which removes the token from Vault');
reset role;
select is((select count(*)::int from public.inbox_events where kind in ('connected', 'disconnected')), 3, 'connecting and disconnecting are in the history');
select is((select count(*)::int from public.inbox_threads), 2, 'and disconnecting keeps the imported conversations');

select * from finish();
rollback;
