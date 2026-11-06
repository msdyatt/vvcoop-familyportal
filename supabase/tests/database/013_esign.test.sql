-- In-house e-signing: who may sign, in what order, what is recorded, and what
-- can never be changed afterwards.
begin;
select plan(103);

-- A1 administrator. Household F1: P1 and P2, both fully set up. F2: P3 alone.
-- F3: P4 (no second factor yet) and P5 (set up). O is an outsider.
insert into auth.users (id, email, aud, role, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'p1@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b2', 'p2@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b3', 'p3@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b4', 'p4@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b5', 'p5@t.test', 'authenticated', 'authenticated', now()),
  ('00000000-0000-0000-0000-0000000000b6', 'o@t.test', 'authenticated', 'authenticated', now());
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) where email like '%@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000b2', 'parent'),
  ('00000000-0000-0000-0000-0000000000b3', 'parent'), ('00000000-0000-0000-0000-0000000000b4', 'parent'),
  ('00000000-0000-0000-0000-0000000000b5', 'parent'), ('00000000-0000-0000-0000-0000000000b6', 'parent');
insert into public.families (id, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'One'), ('00000000-0000-0000-0000-0000000000f2', 'Two'),
  ('00000000-0000-0000-0000-0000000000f3', 'Three'), ('00000000-0000-0000-0000-0000000000f4', 'Four');
insert into public.family_members (family_id, user_id, relationship, created_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', 'Parent', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3', 'Parent', now()),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b4', 'Parent', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000b5', 'Parent', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000b6', 'Parent', now());
-- Everyone except P4 has a verified second factor.
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
select gen_random_uuid(), u.id, 'totp', 'verified', now(), now()
from auth.users u where u.email in ('admin@t.test', 'p1@t.test', 'p2@t.test', 'p3@t.test', 'p5@t.test', 'o@t.test');

insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000c1', '2026-27', true);
insert into public.requirements (id, school_year_id, kind, title) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'document', 'Liability <waiver> & release');

-- Two uploaded PDFs (the files themselves live in storage).
insert into storage.objects (bucket_id, name) values
  ('family-village-private', 'sign/templates/00000000-0000-0000-0000-0000000000d1/original.pdf'),
  ('family-village-private', 'sign/templates/00000000-0000-0000-0000-0000000000d2/original.pdf');

-- ---- who may call what ---------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.sign_submit(uuid,jsonb,jsonb,jsonb)', 'EXECUTE'), 'visitors cannot sign');
select ok(has_function_privilege('authenticated', 'public.sign_submit(uuid,jsonb,jsonb,jsonb)', 'EXECUTE'), 'signed-in users can call the signing function (it checks who they are)');
select ok(not has_function_privilege('authenticated', 'public.sign_complete(uuid,text,text)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.sign_complete(uuid,text,text)', 'EXECUTE'), 'only the service role can complete a request');
select ok(has_function_privilege('service_role', 'public.sign_complete(uuid,text,text)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.sign_claim_seal(uuid)', 'EXECUTE'), 'the service role can seal');
select ok(not has_table_privilege('authenticated', 'public.sign_events', 'INSERT')
          and not has_table_privilege('authenticated', 'public.sign_requests', 'INSERT')
          and not has_table_privilege('authenticated', 'public.sign_signers', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.sign_field_values', 'INSERT'), 'nobody writes the signing tables directly');
select ok(not has_table_privilege('service_role', 'public.sign_events', 'UPDATE')
          and not has_table_privilege('service_role', 'public.sign_events', 'DELETE')
          and not has_table_privilege('service_role', 'public.sign_events', 'TRUNCATE'), 'not even the service role can change the audit trail');

-- ---- administrators: templates and fields ---------------------------------------------------
create temp table sent (r jsonb);
create temp table seq (r jsonb);
create temp table req (id uuid, family_id uuid);
create temp table seqreq (id uuid);
grant all on sent, seq, req, seqreq to public;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select throws_ok($$select public.sign_create_template('00000000-0000-0000-0000-0000000000d1', 'Waiver', 3, repeat('a', 64))$$,
  'P0001', 'Administrator access is required.', 'a parent cannot register a document');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.sign_create_template('00000000-0000-0000-0000-0000000000d1', 'Waiver', 3, repeat('a', 64))$$,
  'P0001', 'Complete two-factor verification first.', 'an administrator who has not stepped up to their second factor cannot either');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select throws_ok($$select public.sign_create_template('00000000-0000-0000-0000-0000000000d9', 'Missing', 3, repeat('a', 64))$$,
  'P0001', 'Upload the PDF first.', 'a document must actually be uploaded before it is registered');
select lives_ok($$select public.sign_create_template('00000000-0000-0000-0000-0000000000d1', 'Liability waiver', 3, repeat('a', 64))$$, 'an administrator registers an uploaded PDF');
select lives_ok($$select public.sign_create_template('00000000-0000-0000-0000-0000000000d2', 'Handbook', 2, repeat('b', 64))$$, 'and a second one');

select throws_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d1', null,
  '[{"page":1,"x":0.1,"y":0.1,"w":0.3,"h":0.05,"kind":"signature","slot":2}]'::jsonb)$$,
  'P0001', 'Signer 2 needs a signer 1 on the same document.', 'signer 2 cannot exist without signer 1');
select throws_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d1', null,
  '[{"page":9,"x":0.1,"y":0.1,"w":0.3,"h":0.05,"kind":"signature","slot":1}]'::jsonb)$$,
  'P0001', 'A field is on page 9, but the document has 3 pages.', 'a field cannot be on a page that does not exist');
select throws_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d1', null,
  '[{"page":1,"x":0.9,"y":0.1,"w":0.3,"h":0.05,"kind":"signature","slot":1}]'::jsonb)$$,
  '23514', null, 'a field cannot hang off the edge of the page');

select lives_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d1', null, '[
  {"page":1,"x":0.1,"y":0.80,"w":0.30,"h":0.05,"kind":"signature","slot":1,"required":true},
  {"page":1,"x":0.5,"y":0.80,"w":0.20,"h":0.04,"kind":"date","slot":1},
  {"page":2,"x":0.1,"y":0.30,"w":0.40,"h":0.04,"kind":"text","slot":1,"required":true,"label":"Emergency phone"},
  {"page":3,"x":0.1,"y":0.80,"w":0.30,"h":0.05,"kind":"signature","slot":2},
  {"page":3,"x":0.5,"y":0.80,"w":0.10,"h":0.04,"kind":"initials","slot":2},
  {"page":3,"x":0.1,"y":0.70,"w":0.03,"h":0.03,"kind":"checkbox","slot":2,"required":true,"label":"I have read this"}]'::jsonb)$$,
  'fields are placed on any page for either signer');
select lives_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d2', null, '[
  {"page":1,"x":0.1,"y":0.80,"w":0.30,"h":0.05,"kind":"signature","slot":1},
  {"page":2,"x":0.1,"y":0.80,"w":0.30,"h":0.05,"kind":"signature","slot":2}]'::jsonb)$$, 'the second document too');
select is((select signers_required::int from public.sign_templates where id = '00000000-0000-0000-0000-0000000000d1'), 2, 'two signers are required once slot 2 has fields');
select is((select status from public.sign_templates where id = '00000000-0000-0000-0000-0000000000d1'), 'ready', 'and it is ready to send');

-- ---- sending -----------------------------------------------------------------------------------
insert into sent select public.sign_send(
  '00000000-0000-0000-0000-0000000000d1', array['00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2',
    '00000000-0000-0000-0000-0000000000f3']::uuid[], '00000000-0000-0000-0000-0000000000c2', false, 'Please sign by Friday', null);
select is((select jsonb_array_length(r -> 'sent') from sent), 2, 'sent to the two households that have two adults');
select is((select r -> 'skipped' -> 0 ->> 'reason' from sent), 'needs_two_adults', 'a single-adult household is skipped, with the reason');
select is((select status from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'), 'sent', 'the household''s requirement is marked sent');
select is((select count(*)::int from public.sign_signers where request_id in (select (e ->> 'request_id')::uuid from sent, jsonb_array_elements(r -> 'sent') e)), 4, 'two signers per request');
select is((select user_id::text from public.sign_signers s join public.sign_requests r on r.id = s.request_id
           where r.family_id = '00000000-0000-0000-0000-0000000000f1' and s.slot = 1), '00000000-0000-0000-0000-0000000000b1',
          'slot 1 is the adult who joined first');
select is((select count(*)::int from public.notifications where kind = 'sign_request'), 4, 'every signer is notified in the app');
select is((select count(*)::int from public.email_outbox where kind = 'sign_request' and html_body like '%Liability%'), 4, 'and by email');
select is((select count(*)::int from public.email_outbox where kind = 'sign_request' and html_body like '%http%' and html_body not like '%family.veritasvillage.org/family-village/paperwork%'), 0, 'the only link is to the portal''s own paperwork page');
select is((select count(*)::int from public.sign_events where action in ('created', 'sent')), 4, 'creating and sending are in the audit trail');
select is((select count(*)::int from public.audit_log where action = 'sign_request_sent'), 2, 'and in the administrators'' activity log');

select is((select r -> 'skipped' -> 0 ->> 'reason' from (select public.sign_send('00000000-0000-0000-0000-0000000000d1', array['00000000-0000-0000-0000-0000000000f1']::uuid[]) as r) x),
  'already_sent', 'sending the same document to the same household twice is refused');
select throws_ok($$select public.sign_save_fields('00000000-0000-0000-0000-0000000000d1', null, '[]'::jsonb)$$,
  'P0001', 'This document has been sent, so its fields are locked. Make a copy to change them.', 'once sent, the fields are frozen');
reset role;

select throws_ok($$update public.sign_templates set sha256 = repeat('c', 64) where id = '00000000-0000-0000-0000-0000000000d1'$$,
  'P0001', 'This document has been sent, so its file is locked.', 'and so is the file, by its hash');
select throws_ok($$update public.sign_requests set original_sha256 = repeat('c', 64)$$, 'P0001', 'The file and terms of a sent request are locked.', 'a request keeps the hash it was sent with');
select throws_ok($$delete from public.sign_requests$$, 'P0001', 'A signature request is a record and cannot be deleted. Void it instead.', 'a request cannot be deleted');

-- ---- the audit trail is append-only ------------------------------------------------------------
select throws_ok($$update public.sign_events set actor_name = 'x'$$, 'P0001', 'The signing audit trail is append-only.', 'events cannot be edited');
select throws_ok($$delete from public.sign_events$$, 'P0001', 'The signing audit trail is append-only.', 'cannot be deleted');
select throws_ok($$truncate public.sign_events$$, 'P0001', 'The signing audit trail is append-only.', 'cannot be truncated');

-- ---- who can see what ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select count(*)::int from public.sign_requests), 1, 'a parent sees their own household''s request and no one else''s');
select is((select count(*)::int from public.sign_signers), 2, 'both signers on it');
select ok((select count(*) from public.sign_fields) > 0, 'and the fields of the document they were sent');
select is((select count(*)::int from public.sign_templates), 0, 'but not the template library');
select ok(private.can_read_sign_file('sign/templates/00000000-0000-0000-0000-0000000000d1/original.pdf'), 'they can open the PDF they were sent');
select ok(not private.can_read_sign_file('sign/templates/00000000-0000-0000-0000-0000000000d2/original.pdf'), 'but not one that was not sent to them');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b6","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select count(*)::int from public.sign_requests) + (select count(*)::int from public.sign_events) + (select count(*)::int from public.sign_fields), 0, 'another household sees nothing at all');
select ok(not private.can_read_sign_file('sign/templates/00000000-0000-0000-0000-0000000000d1/original.pdf'), 'and cannot open the file');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select count(*)::int from public.sign_requests), 0, 'a session that has not reached the second factor reads nothing');
reset role;

-- ---- account gating ---------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is((select public.sign_eligibility() ->> 'eligible'), 'true', 'a finished account can sign');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select public.sign_eligibility() -> 'blockers' ->> 0), 'mfa_not_verified', 'a session at the first factor only is told to verify');
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b4","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select is((select public.sign_eligibility() -> 'blockers' ->> 0), 'mfa_not_enrolled', 'someone with no second factor is told to set one up');
select throws_ok($$select public.sign_give_consent((select id from public.sign_requests where family_id = '00000000-0000-0000-0000-0000000000f3'))$$,
  'P0001', 'Finish setting up your account before signing.', 'and cannot consent');
reset role;

-- Each other way an account can be unfinished, one at a time (P3 stands in).
update public.profiles set status = 'pending' where id = '00000000-0000-0000-0000-0000000000b3';
select is(private.signing_blockers('00000000-0000-0000-0000-0000000000b3'), array['account_not_active'], 'an inactive profile cannot sign');
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000b3';
update auth.users set email_confirmed_at = null where id = '00000000-0000-0000-0000-0000000000b3';
select is(private.signing_blockers('00000000-0000-0000-0000-0000000000b3'), array['invitation_not_accepted'], 'an unconfirmed invitation cannot sign');
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000b3';
insert into public.invitations (email, invited_by_user_id, token_hash, expires_at) values ('p3@t.test', '00000000-0000-0000-0000-0000000000a1', 'h3', now() + interval '1 day');
select is(private.signing_blockers('00000000-0000-0000-0000-0000000000b3'), array['invitation_not_accepted'], 'a pending invitation that was never accepted cannot sign');
update public.invitations set accepted_at = now() where token_hash = 'h3';
update public.profiles set display_name = '  ' where id = '00000000-0000-0000-0000-0000000000b3';
select is(private.signing_blockers('00000000-0000-0000-0000-0000000000b3'), array['profile_incomplete'], 'a profile with no name cannot sign');
update public.profiles set display_name = 'P3' where id = '00000000-0000-0000-0000-0000000000b3';
select is(private.signing_blockers('00000000-0000-0000-0000-0000000000b3'), '{}'::text[], 'once all of that is fixed they can');

-- ---- signing: consent, order, validation ----------------------------------------------------------------
insert into req select id, family_id from public.sign_requests where family_id = '00000000-0000-0000-0000-0000000000f1';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated","aal":"aal2"}', true);
select set_config('request.headers', '{"cf-connecting-ip":"203.0.113.9","user-agent":"TestAgent/1.0"}', true);
set local role authenticated;

select throws_ok($$select public.sign_submit((select id from req), '{"kind":"typed","text":"P1"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'Agree to sign electronically first.', 'signing without consent is refused');
select lives_ok($$select public.sign_record_view((select id from req))$$, 'opening the document is recorded');
select lives_ok($$select public.sign_give_consent((select id from req))$$, 'consent is recorded');
select is((select ip from public.sign_events where action = 'consent_given'), '203.0.113.9', 'with the address the platform saw');
select is((select user_agent from public.sign_events where action = 'consent_given'), 'TestAgent/1.0', 'and the browser');
select is((select detail ->> 'consent_text' from public.sign_events where action = 'consent_given'), public.sign_consent_text(), 'and the exact wording they agreed to');

select throws_ok($$select public.sign_submit((select id from req), null, null, '{}'::jsonb)$$,
  'P0001', 'Add your signature.', 'a signature is required');
select throws_ok($$select public.sign_submit((select id from req), '{"kind":"typed","text":"P1"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'Fill in every required field (Emergency phone).', 'so is every required field');
select throws_ok($$select public.sign_submit((select id from req), '{"kind":"drawn","png":"not-a-png"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'Your drawn signature could not be read. Try again or type it instead.', 'a drawn signature must be a real image');
select throws_ok(format($q$select public.sign_submit((select id from req), '{"kind":"typed","text":"P1"}'::jsonb, null,
  jsonb_build_object(%L, 'x'))$q$, (select id from public.sign_fields where kind = 'signature' and signer_slot = 2 limit 1)),
  'P0001', 'Those answers do not match this document.', 'answers for someone else''s fields are refused');

select is((select public.sign_submit((select id from req), '{"kind":"typed","text":"Parent One"}'::jsonb, null,
  jsonb_build_object((select id::text from public.sign_fields where kind = 'text'), '555-0100')) ->> 'status'), 'in_progress', 'the first signer signs and the request is in progress');
select throws_ok($$select public.sign_submit((select id from req), '{"kind":"typed","text":"P1"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'You have already signed.', 'nobody signs twice');
select is((select value from public.sign_field_values v join public.sign_fields f on f.id = v.field_id where f.kind = 'date'),
  to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD'), 'the date is filled in by the database');
select is((select count(*)::int from public.sign_events where action = 'field_filled'), 3, 'each field filled is in the audit trail');
select is((select detail ->> 'account_name' from public.sign_events where action = 'signed'), 'P1', 'the signing event names the signed-in account');
select throws_ok($$update public.sign_signers set signature = null$$, '42501', null, 'a signature cannot be edited from the client');
reset role;

select throws_ok($$update public.sign_signers set signature = null where status = 'signed'$$, 'P0001', 'A completed signature cannot be changed.', 'or by anyone else');

-- a stranger to this request
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b3","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select throws_ok($$select public.sign_give_consent((select id from req))$$, 'P0001', 'There is nothing for you to sign here.', 'someone who is not a signer on the request cannot sign it');
reset role;

-- the second signer
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok($$select public.sign_give_consent((select id from req))$$, 'the second adult consents separately');
select throws_ok($$select public.sign_submit((select id from req), '{"kind":"typed","text":"P2"}'::jsonb, '{"kind":"typed","text":"P2"}'::jsonb, '{}'::jsonb)$$,
  'P0001', 'Tick every required box (I have read this).', 'a required box must be ticked');
select is((select public.sign_submit((select id from req),
  ('{"kind":"drawn","png":"iVBORw0KGgo' || repeat('A', 200) || '"}')::jsonb, '{"kind":"typed","text":"P2"}'::jsonb,
  jsonb_build_object((select id::text from public.sign_fields where kind = 'checkbox'), true)) ->> 'all_signed'), 'true', 'when the second signs, everyone has signed');
reset role;

select is((select status from public.sign_requests where id = (select id from req)), 'signed', 'the request waits to be sealed');
select ok(public.sign_claim_seal((select id from req)), 'the sealing service claims it');
select ok(not public.sign_claim_seal((select id from req)), 'and nobody else can at the same time');

-- ---- sequential order ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
insert into seq select public.sign_send('00000000-0000-0000-0000-0000000000d2',
  array['00000000-0000-0000-0000-0000000000f3']::uuid[], null, true);
reset role;
insert into seqreq select (r -> 'sent' -> 0 ->> 'request_id')::uuid from seq;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b5","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select lives_ok($$select public.sign_give_consent((select id from seqreq))$$, 'the second signer can consent early');
select throws_ok($$select public.sign_submit((select id from seqreq), '{"kind":"typed","text":"P5"}'::jsonb, null, '{}'::jsonb)$$,
  'P0001', 'The other signer goes first.', 'but cannot sign before the first when the order is sequential');
reset role;

-- ---- reminders and voiding ---------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
select is(public.sign_remind((select id from seqreq)), 1, 'a reminder in sequential order goes only to the signer whose turn it is');
select is(public.sign_remind((select id from seqreq)), 0, 'and not again within the hour');
select lives_ok($$select public.sign_void((select id from seqreq), 'Wrong version')$$, 'an administrator voids a request');
reset role;
select is((select status from public.sign_requests where id = (select id from seqreq)), 'voided', 'it is marked voided');
select is((select count(*)::int from public.sign_events where action = 'voided' and request_id = (select id from seqreq)), 1, 'and the audit trail says so');

-- ---- completing -------------------------------------------------------------------------------------------------------
select throws_ok($$select public.sign_complete((select id from req), repeat('e', 64), repeat('d', 64))$$,
  'P0001', 'The sealed file has not been stored.', 'a request cannot be completed before the sealed PDF is stored');
insert into storage.objects (bucket_id, name) select 'family-village-private', 'sign/requests/' || id::text || '/sealed.pdf' from req;
select ok((select public.sign_complete((select id from req), repeat('e', 64), repeat('d', 64))) is not null, 'completing files the signed document');
select is((select status from public.sign_requests where id = (select id from req)), 'completed', 'the request is completed');
select is((select status from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'), 'complete', 'the requirement is marked complete');
select is((select signed_document_id from public.family_requirements where family_id = '00000000-0000-0000-0000-0000000000f1'),
  (select document_id from public.sign_requests where id = (select id from req)), 'pointing at the signed document');
select is((select count(*)::int from public.documents where kind = 'signed' and signature_provider = 'in_app'), 1, 'which is filed under the household''s documents');
select throws_ok($$update public.sign_requests set sealed_sha256 = repeat('f', 64) where id = (select id from req)$$, 'P0001', 'A sealed record cannot be replaced.', 'a sealed record cannot be replaced');
select throws_ok($$select public.sign_void((select id from req), 'oops')$$, 'P0001', 'A sealed record cannot be voided.', 'or voided');

-- ---- erasing an account leaves the record -------------------------------------------------------------------
create temp table erased (r jsonb);
insert into erased select public.erase_account_data('00000000-0000-0000-0000-0000000000b1');
select is((select email from public.sign_signers where request_id = (select id from req) and slot = 1), null, 'erasing a signer clears the email stored beside their name');
select is((select display_name from public.sign_signers where request_id = (select id from req) and slot = 1), 'P1', 'but the name stays, as it is printed on the certificate');
select lives_ok($$delete from auth.users where id = '00000000-0000-0000-0000-0000000000b1'$$, 'their sign-in can then be deleted despite the signed record');
select is((select user_id from public.sign_signers where request_id = (select id from req) and slot = 1), null, 'the signer row no longer points at an account');
select ok((select count(*) from public.sign_events where actor_user_id = '00000000-0000-0000-0000-0000000000b1') >= 4, 'and the audit trail still shows what they did');
select is((select status from public.sign_requests where id = (select id from req)), 'completed', 'the sealed record is untouched');

create temp table erased2 (r jsonb);
insert into erased2 select public.erase_account_data('00000000-0000-0000-0000-0000000000b2', true);
select is((select r -> 'households_deleted' ->> 0 from erased2), 'One', 'deleting the last adult and the household');
select ok(not (select r -> 'storage_paths' from erased2) ? ('sign/requests/' || (select id::text from req) || '/sealed.pdf'),
  'does not queue the sealed signature record for deletion');
select is((select sealed_path is not null and family_id is null from public.sign_requests where id = (select id from req)), true,
  'the request keeps pointing at its sealed file after the household is gone');
select ok((select count(*) from public.sign_events where request_id = (select id from req)) > 0, 'with its whole audit trail');

select * from finish();
rollback;
