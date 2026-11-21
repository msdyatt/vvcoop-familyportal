-- Admin permissions: tier defaults, a grant, a revoke, a day-to-day admin refused on every gated
-- function and table, the log, and the guard that keeps at least one board admin able to manage
-- permissions.
-- Fixtures (all fake): A1 and A2 board admins; A3 a day-to-day admin (no tier row, the default);
-- A4 a board admin with a second factor; P1 a parent in household F1.
begin;
select plan(84);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'board.one@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a2', 'board.two@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin.day@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000a4', 'board.mfa@example.com', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent.one@example.com', 'authenticated', 'authenticated');
update public.profiles set status = 'active', display_name = split_part(email, '@', 1) where email like '%@example.com';
insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'admin'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin'), ('00000000-0000-0000-0000-0000000000a4', 'admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'parent');
insert into public.admin_tiers (user_id, tier) values
  ('00000000-0000-0000-0000-0000000000a1', 'board'), ('00000000-0000-0000-0000-0000000000a2', 'board'),
  ('00000000-0000-0000-0000-0000000000a4', 'board');
insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a4', 'totp', 'verified', now(), now());
insert into public.families (id, display_name) values ('00000000-0000-0000-0000-0000000000f1', 'Example');
insert into public.family_members (family_id, user_id, relationship) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', 'Parent');
insert into public.school_years (id, label, is_current) values ('00000000-0000-0000-0000-0000000000e0', '2026-27', true);
insert into public.requirements (id, school_year_id, kind, title, amount_per_family) values
  ('00000000-0000-0000-0000-0000000000d0', '00000000-0000-0000-0000-0000000000e0', 'dues', 'Dues', 300);
update public.billing_settings set provider = 'off' where id = 'dues';

-- --- tier defaults ----------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(public.my_admin_access() ->> 'tier', 'board', 'a board admin is on the board tier');
select is(public.my_admin_access() -> 'permissions',
  '{"integrations": true, "year_setup": true, "dues_settings": true, "tax_compliance": true, "manage_permissions": true}'::jsonb,
  'and has all five permissions by default');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select is(public.my_admin_access() ->> 'tier', 'admin', 'an admin with no tier row is a day-to-day admin');
select is(public.my_admin_access() -> 'permissions',
  '{"integrations": false, "year_setup": false, "dues_settings": false, "tax_compliance": false, "manage_permissions": false}'::jsonb,
  'and has none of the five by default');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is((public.my_admin_access() ->> 'is_admin')::boolean, false, 'a parent is not an admin');
select is(public.my_admin_access() -> 'permissions' ->> 'integrations', 'false', 'and has no permissions');
reset role;

-- --- a day-to-day admin is refused in every gated area -----------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
-- tax and compliance records
select throws_ok($$select public.admin_tax_summary(2026)$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: tax summary');
select throws_ok($$select public.admin_set_tax_year_inputs(2026, 0, null, null)$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: tax year inputs');
select throws_ok($$select public.admin_compliance_rules()$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: compliance rules');
select throws_ok($$select public.admin_regenerate_compliance_deadlines()$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: regenerate deadlines');
select throws_ok($$select public.admin_list_org_facts()$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: records vault key facts');
select throws_ok($$select public.admin_set_org_fact('ein', '12-3456789', 'x')$$, '42501', 'Ask a board admin. This needs the "Tax and compliance records" permission.', 'refused: editing a key fact');
select is((select count(*)::int from public.compliance_settings), 0, 'refused: reading compliance settings directly');
select is((select count(*)::int from public.org_records), 0, 'refused: reading vault records directly');
-- school year setup
select throws_ok($$select public.admin_rollover_households('00000000-0000-0000-0000-0000000000e0')$$, '42501', 'Ask a board admin. This needs the "School year setup" permission.', 'refused: returning households');
select throws_ok($$select public.admin_set_household_returning('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000f1', false)$$, '42501', 'Ask a board admin. This needs the "School year setup" permission.', 'refused: marking a family not returning');
select throws_ok($$select public.admin_rollover_preview('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e0', '{}'::jsonb, '{}'::uuid[])$$, '42501', 'Ask a board admin. This needs the "School year setup" permission.', 'refused: rollover preview');
select throws_ok($$select public.admin_rollover_school_year('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e0', '{}'::jsonb, '{}'::uuid[])$$, '42501', 'Ask a board admin. This needs the "School year setup" permission.', 'refused: start the next year');
select throws_ok($$insert into public.school_years (label) values ('2027-28')$$, '42501', null, 'refused: adding a school year directly');
select throws_ok($$insert into public.academic_terms (school_year_id, label, starts_on, ends_on) values ('00000000-0000-0000-0000-0000000000e0', 'Fall', '2026-09-01', '2026-12-15')$$, '42501', null, 'refused: adding a term directly');
select throws_ok($$insert into public.enrollment_periods (title, opens_at, closes_at, school_year_id) values ('Fall', now(), now() + interval '1 day', '00000000-0000-0000-0000-0000000000e0')$$, '42501', null, 'refused: adding an enrollment window directly');
update public.school_years set is_current = false where id = '00000000-0000-0000-0000-0000000000e0';
select lives_ok($$select public.admin_place_children_by_grade('00000000-0000-0000-0000-0000000000e0', true)$$, 'placing children by grade stays day-to-day');
-- dues and fees
select throws_ok($$select public.admin_set_dues_options('00000000-0000-0000-0000-0000000000d0', true, 9, null)$$, '42501', 'Ask a board admin. This needs the "Dues and fees" permission.', 'refused: payment plan options');
select throws_ok($$select public.admin_update_billing_settings(3, 3, 3, 'Example', null, null, null)$$, '42501', 'Ask a board admin. This needs the "Dues and fees" permission.', 'refused: billing and receipt settings');
select throws_ok($$select public.admin_create_discount_type('sib', 'Sibling', 'percent', 10)$$, '42501', 'Ask a board admin. This needs the "Dues and fees" permission.', 'refused: a discount type');
select throws_ok($$insert into public.requirements (school_year_id, kind, title, amount_per_family) values ('00000000-0000-0000-0000-0000000000e0', 'dues', 'More dues', 50)$$, '42501', null, 'refused: adding a dues amount');
update public.requirements set amount_per_family = 1 where id = '00000000-0000-0000-0000-0000000000d0';
select lives_ok($$insert into public.requirements (school_year_id, kind, title) values ('00000000-0000-0000-0000-0000000000e0', 'document', 'Photo release')$$, 'a document requirement stays day-to-day');
-- integrations
select throws_ok($$select public.admin_set_billing_provider('stripe_test')$$, '42501', 'Ask a board admin. This needs the "Integrations" permission.', 'refused: Stripe mode');
select throws_ok($$select public.admin_purge_test_billing_data()$$, '42501', 'Ask a board admin. This needs the "Integrations" permission.', 'refused: deleting Stripe test data');
select throws_ok($$select public.office_inbox_save_setup('123456789-abc.apps.googleusercontent.com', 'GOCSPX-examplevalue', 'office@example.com', 'https://family.example.com')$$, '42501', 'Ask a board admin. This needs the "Integrations" permission.', 'refused: the office inbox Google setup');
select lives_ok($$select public.office_inbox_setup()$$, 'reading the office inbox setup stays day-to-day');
update public.integration_settings set from_address = 'someone@example.com' where id = 'resend';
-- manage permissions
select throws_ok($$select public.admin_permissions_overview()$$, '42501', 'Ask a board admin. Only board admins can see admin permissions.', 'refused: the permissions screen');
select throws_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a3', 'board')$$, '42501', 'Ask a board admin. This needs the "Admin permissions" permission.', 'refused: promoting themselves');
select throws_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a3', 'integrations', true)$$, '42501', 'Ask a board admin. This needs the "Admin permissions" permission.', 'refused: granting themselves a permission');
select throws_ok($$insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000b1', 'admin')$$, '42501', null, 'refused: making someone an admin');
select lives_ok($$insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000b1', 'teacher')$$, 'giving the teacher role stays day-to-day');
delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1' and role = 'admin';
select throws_ok($$update public.profiles set status = 'suspended' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501', 'Ask a board admin. Changing an admin''s account needs the "Admin permissions" permission.', 'refused: suspending an admin');
reset role;
select is((select amount_per_family::int from public.requirements where id = '00000000-0000-0000-0000-0000000000d0'), 300, 'the dues amount did not change');
select is((select from_address from public.integration_settings where id = 'resend'), null, 'the integration setting did not change');
select ok(exists (select 1 from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1' and role = 'admin'), 'a board admin''s role was not removed');
select ok((select is_current from public.school_years where id = '00000000-0000-0000-0000-0000000000e0'), 'the current school year did not change');

-- Edge Functions ask for a person they have already identified, as the service role.
set local role service_role;
select is(public.admin_has_permission('00000000-0000-0000-0000-0000000000a3', 'integrations'), false, 'service check: a day-to-day admin has no integrations permission');
select is(public.admin_has_permission('00000000-0000-0000-0000-0000000000a1', 'integrations'), true, 'service check: a board admin does');
select throws_ok($$select public.office_inbox_begin_oauth('00000000-0000-0000-0000-0000000000a3', 'h1', 'v1')$$, '42501', 'Ask a board admin. This needs the "Integrations" permission.', 'refused: connecting the office inbox');
select throws_ok($$select public.office_inbox_clear_connection('00000000-0000-0000-0000-0000000000a3')$$, '42501', 'Ask a board admin. This needs the "Integrations" permission.', 'refused: disconnecting the office inbox');
select lives_ok($$select public.office_inbox_begin_oauth('00000000-0000-0000-0000-0000000000a1', repeat('a', 64), repeat('v', 64))$$, 'a board admin can start connecting it');
reset role;
set local role authenticated;
select throws_ok($$select public.admin_has_permission('00000000-0000-0000-0000-0000000000a1', 'integrations')$$, '42501', null, 'signed-in people cannot call the service check');
reset role;

-- Second factor still applies.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a3', 'board')$$, '42501', 'Complete two-factor verification before continuing.', 'a board admin must pass the second factor');
reset role;

-- --- a grant ----------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a3', 'integrations', true)$$, 'a board admin grants integrations to a day-to-day admin');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select is(public.my_admin_access() -> 'permissions' ->> 'integrations', 'true', 'they now have it');
select lives_ok($$select public.admin_set_billing_provider('stripe_test')$$, 'and can change the Stripe mode');
select throws_ok($$select public.admin_update_billing_settings(3, 3, 3, 'Example', null, null, null)$$, '42501', 'Ask a board admin. This needs the "Dues and fees" permission.', 'but still nothing else');
reset role;
select is((select provider from public.billing_settings where id = 'dues'), 'stripe_test', 'the Stripe mode changed');

-- --- a revoke ---------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a2', 'dues_settings', false)$$, 'a board admin revokes dues from another board admin');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_update_billing_settings(3, 3, 3, 'Example', null, null, null)$$, '42501', 'Ask a board admin. This needs the "Dues and fees" permission.', 'they are refused');
select lives_ok($$select public.admin_compliance_rules()$$, 'but keep the rest of the board tier');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a2', 'dues_settings', true)$$, 'switching it back on');
select throws_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a2', 'nonsense', true)$$, 'P0001', 'That is not an admin permission.', 'only known permissions can be set');
reset role;
select is((select count(*)::int from public.admin_permission_overrides where user_id = '00000000-0000-0000-0000-0000000000a2'), 0, 'returns them to the tier default (no override kept)');

-- --- the log ----------------------------------------------------------------------------------
select is((select string_agg(action || ':' || coalesce(permission, '-') || ':' || coalesce(new_value, '-'), ', ' order by id)
           from public.admin_permission_audit where actor_user_id = '00000000-0000-0000-0000-0000000000a1'),
  'permission_granted:integrations:true, permission_revoked:dues_settings:false, permission_default:dues_settings:true',
  'every change is logged with who made it');
select throws_ok($$update public.admin_permission_audit set new_value = 'x'$$, '23000', 'The admin permission log is never edited or deleted.', 'the log cannot be edited');
select throws_ok($$delete from public.admin_permission_audit$$, '23000', 'The admin permission log is never edited or deleted.', 'or deleted');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;
-- Four 'admin_added' rows from the fixtures, then the three changes above.
select is((select count(*)::int from public.admin_permission_audit), 7, 'board admins can read the log');
select is(jsonb_array_length(public.admin_permissions_overview() -> 'admins'), 4, 'and see every admin');
select is((public.admin_permissions_overview() -> 'log' -> 0 ->> 'actor'), 'board.one', 'with names in the log');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.admin_permission_audit), 0, 'a day-to-day admin cannot read the log');
reset role;

-- --- adding and removing admins ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-0000000000b1', 'admin')$$, 'a board admin can make someone an admin');
reset role;
select is(private.admin_tier_of('00000000-0000-0000-0000-0000000000b1'), 'admin', 'a new admin starts on the day-to-day tier');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000b1', 'board')$$, 'and can move them to the board');
select lives_ok($$delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000b1' and role = 'admin'$$, 'and remove the admin role again');
reset role;
select is((select count(*)::int from public.admin_tiers where user_id = '00000000-0000-0000-0000-0000000000b1'), 0, 'removing the role clears their tier');
select is((select string_agg(action, ', ' order by id) from public.admin_permission_audit where subject_user_id = '00000000-0000-0000-0000-0000000000b1'),
  'admin_added, tier_changed, admin_removed', 'and all three steps are logged');

-- --- the last board admin who can manage permissions --------------------------------------------
-- A2 and A4 step down, leaving A1 as the only board admin with manage_permissions.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a2', 'admin')$$, 'a board admin can move another to the day-to-day tier');
select lives_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a4', 'manage_permissions', false)$$, 'or take manage permissions away from another');
-- A3 gets manage_permissions, but is not on the board, so does not count.
select lives_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a3', 'manage_permissions', true)$$, 'a day-to-day admin can be given manage permissions');
select throws_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a1', 'admin')$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'the last one cannot demote themselves');
select throws_ok($$select public.admin_set_admin_permission('00000000-0000-0000-0000-0000000000a1', 'manage_permissions', false)$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'or revoke their own manage permissions');
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
set local role authenticated;
select throws_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a1', 'admin')$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'nor can anyone else demote them');
reset role;
select throws_ok($$delete from public.user_roles where user_id = '00000000-0000-0000-0000-0000000000a1' and role = 'admin'$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'their admin role cannot be removed');
select throws_ok($$update public.profiles set status = 'suspended' where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'their account cannot be suspended');
select throws_ok($$delete from auth.users where id = '00000000-0000-0000-0000-0000000000a1'$$, '42501',
  'At least one board admin must keep the "Admin permissions" permission. Give it to another board admin first.', 'or deleted');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select lives_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a2', 'board')$$, 'once another board admin can manage permissions');
select lives_ok($$select public.admin_set_admin_tier('00000000-0000-0000-0000-0000000000a1', 'admin')$$, 'the first one can step down');
reset role;
select is((select count(*)::int from public.admin_tiers where tier = 'board' and private.is_permission_manager(user_id)), 1, 'leaving exactly one');

select * from finish();
rollback;
