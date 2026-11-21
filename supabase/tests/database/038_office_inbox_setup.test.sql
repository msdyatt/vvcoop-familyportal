-- Office inbox setup on the Integrations card: administrators only; the client secret goes into
-- Vault, is never returned to a browser and only the service role reads it; every save is logged
-- without the secret; the mailbox cannot be swapped while another one is connected.
begin;
select plan(31);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'mfa@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent@t.test', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000c1', 'reviewer@t.test', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = initcap(split_part(email, '@', 1)) where email like '%@t.test';
update public.profiles set is_demo = true where email = 'reviewer@t.test';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a3', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent'), ('00000000-0000-0000-0000-0000000000c1', 'admin');
-- Since admin permissions (20261121160000), board-only areas need a board admin.
insert into public.admin_tiers (user_id, tier) select user_id, 'board' from public.user_roles where role = 'admin' on conflict do nothing;
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', 'totp', 'verified', now(), now());

-- ---- who may call what --------------------------------------------------------------------------
select ok(not has_function_privilege('anon', 'public.office_inbox_setup()', 'EXECUTE')
          and not has_function_privilege('anon', 'public.office_inbox_save_setup(text,text,text,text,boolean)', 'EXECUTE'), 'visitors cannot read or save the setup');
select ok(not has_function_privilege('authenticated', 'public.office_inbox_google_config()', 'EXECUTE')
          and not has_function_privilege('anon', 'public.office_inbox_google_config()', 'EXECUTE'), 'no signed-in person, administrators included, can read the secret');
select ok(has_function_privilege('service_role', 'public.office_inbox_google_config()', 'EXECUTE'), 'the Edge Functions can');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', 'GOCSPX-secretvalue', 'office@t.test', 'https://family.t.test')$$,
  '42501', 'Administrator access is required.', 'a parent cannot save the setup');
select throws_ok($$select public.office_inbox_setup()$$, '42501', 'Administrator access is required.', 'nor read it');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', 'GOCSPX-secretvalue', 'office@t.test', 'https://family.t.test')$$,
  '42501', 'Administrator access is required.', 'a reviewer account cannot save the setup');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', 'GOCSPX-secretvalue', 'office@t.test', 'https://family.t.test')$$,
  '42501', 'Complete two-factor verification before continuing.', 'an administrator who has not passed the second factor cannot');
reset role;

-- ---- an administrator saves it -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.office_inbox_save_setup(' 123456789-abc.apps.googleusercontent.com ', 'GOCSPX-secretvalue', ' Office@T.test ', 'https://family.t.test/')$$,
  'an administrator can save the setup');
select is((select public.office_inbox_setup()->>'google_client_id'), '123456789-abc.apps.googleusercontent.com', 'the client ID is saved, trimmed');
select is((select public.office_inbox_setup()->>'allowed_mailbox'), 'office@t.test', 'the mailbox is saved in lower case');
select is((select public.office_inbox_setup()->>'portal_site_url'), 'https://family.t.test', 'the portal address loses its trailing slash');
select is((select public.office_inbox_setup()->>'client_secret_saved'), 'true', 'the card is told a secret is saved');
select ok((select public.office_inbox_setup()::text not like '%GOCSPX%'), 'but never what it is');
select ok((select not exists (select 1 from public.office_inbox_settings s where to_jsonb(s)::text like '%GOCSPX%')), 'and it is not in the settings row administrators can read');
select throws_ok($$select public.office_inbox_save_setup('bad id!', null, null, null)$$, 'P0001',
  'That does not look like a Google client ID. Copy it from Google Cloud, Credentials.', 'a malformed client ID is refused');
select throws_ok($$select public.office_inbox_save_setup(null, null, 'not-an-address', null)$$, 'P0001',
  'Enter the office mailbox as an email address, for example office@veritasvillage.org.', 'a malformed mailbox is refused');
select throws_ok($$select public.office_inbox_save_setup(null, null, null, 'http://evil.example/path')$$, 'P0001',
  'Enter the portal address as https:// and the host name only, for example https://family.veritasvillage.org.', 'a portal address with a path or plain http is refused');
select lives_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', '', 'office@t.test', 'https://family.t.test')$$,
  'saving with the secret box left empty');
reset role;

set local role service_role;
select is((select public.office_inbox_google_config()->>'GOOGLE_OAUTH_CLIENT_SECRET'), 'GOCSPX-secretvalue', 'keeps the saved secret, which the Edge Functions read');
select is((select public.office_inbox_google_config()->>'OFFICE_INBOX_ADDRESS'), 'office@t.test', 'along with the other values');
reset role;
select is((select count(*)::int from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'), 1, 'the secret lives in Vault');
select is((select count(*)::int from public.inbox_events where kind = 'setup_saved'), 1, 'saving is logged once (the second save changed nothing)');
select ok((select not exists (select 1 from public.audit_log where detail::text like '%GOCSPX%')), 'the activity log never holds the secret');
select is((select detail->'changed' from public.audit_log where action = 'office_inbox_setup_saved'), '["client_id", "mailbox", "portal_site_url", "client_secret"]'::jsonb,
  'the activity log names the fields that changed');

-- ---- a new secret replaces the old one; removing it is a deliberate step ---------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', 'GOCSPX-newsecret', 'office@t.test', 'https://family.t.test')$$, 'a new secret can be saved');
reset role;
select is((select decrypted_secret from vault.decrypted_secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'), 'GOCSPX-newsecret', 'it replaces the old one');
select is((select count(*)::int from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'), 1, 'with only one copy kept');

-- ---- the mailbox cannot be swapped while another one is connected -------------------------------------------------
update public.office_inbox_settings set status = 'connected', mailbox_address = 'office@t.test';
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', null, 'someone@t.test', 'https://family.t.test')$$, 'P0001',
  'Disconnect the office inbox before changing which mailbox it reads.', 'the mailbox cannot change while another one is connected');
select lives_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', null, 'office@t.test', 'https://family.t.test', true)$$,
  'the secret can be removed on purpose');
select is((select public.office_inbox_setup()->>'client_secret_saved'), 'false', 'and then the card says none is saved');
reset role;
select is((select count(*)::int from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'), 0, 'and it is gone from Vault');

select * from finish();
rollback;
