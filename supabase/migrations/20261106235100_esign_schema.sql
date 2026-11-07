-- In-house electronic signing.
--
-- Replaces OpenSign. A PDF is uploaded once as a template, fields are placed on
-- it as page-relative fractions and assigned to signer slot 1 or 2, and the PDF
-- is then sent to families. Each adult signs inside the portal, signed in.
--
-- Rules, all in SQL so they hold no matter what a client sends:
--   * Only a person whose account is fully set up may consent or sign: active
--     profile, invitation accepted (email confirmed), a name on the profile, a
--     verified second factor or passkey, and a session that has reached aal2.
--     See private.signing_blockers.
--   * A signer row is tied to one account. Only that account can sign it, and
--     only while still in the household.
--   * Signing order can be "any" or "sequential".
--   * The audit trail (sign_events) is append-only. UPDATE, DELETE and TRUNCATE
--     are refused by trigger and the privileges are revoked. The IP address and
--     user agent come from the request headers PostgREST hands the database, not
--     from anything the browser says about itself.
--   * Once a template has been sent, its fields and file are frozen. A request
--     keeps the SHA-256 of the file it was sent with; the sealing function
--     refuses to continue if the stored bytes no longer match.
--   * Nobody writes these tables directly. Everything goes through the
--     functions below. Sealing (flattening the PDF, adding the certificate page)
--     happens in an edge function that calls the service-role-only functions at
--     the end of this file.
--
-- This is engineering, not legal advice. Whether a parent's electronic signature
-- is enough for a liability waiver involving a minor is a question for the
-- co-op's attorney.

-- --- tables ---------------------------------------------------------------------
create table public.sign_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- sign/templates/<id>/original.pdf, uploaded by an administrator
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer not null check (page_count between 1 and 200),
  signers_required smallint not null default 1 check (signers_required in (1, 2)),
  -- draft: no usable fields yet. ready: can be sent. archived: hidden from the send list.
  status text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sign_templates_path_shape check (storage_path = 'sign/templates/' || id::text || '/original.pdf')
);

create table public.sign_fields (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.sign_templates(id) on delete cascade,
  page integer not null check (page >= 1),
  -- Fractions of the page, measured from the top-left corner.
  x double precision not null check (x >= 0 and x <= 1),
  y double precision not null check (y >= 0 and y <= 1),
  w double precision not null check (w > 0 and w <= 1),
  h double precision not null check (h > 0 and h <= 1),
  kind text not null check (kind in ('signature', 'initials', 'date', 'text', 'checkbox')),
  signer_slot smallint not null check (signer_slot in (1, 2)),
  required boolean not null default true,
  label text check (label is null or char_length(label) <= 80),
  created_at timestamptz not null default now(),
  constraint sign_fields_inside_page check (x + w <= 1.0001 and y + h <= 1.0001)
);
create index sign_fields_template_idx on public.sign_fields (template_id, page);

create table public.sign_requests (
  id uuid primary key default gen_random_uuid(),
  -- A template with requests can never be deleted: the record outlives the tool.
  template_id uuid not null references public.sign_templates(id) on delete restrict,
  family_id uuid references public.families(id) on delete set null,
  requirement_id uuid references public.requirements(id) on delete set null,
  family_requirement_id uuid references public.family_requirements(id) on delete set null,
  title text not null,
  -- Snapshot of the file this request was sent with, so the original is locked by hash.
  original_path text not null,
  original_sha256 text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer not null,
  signing_order text not null default 'any' check (signing_order in ('any', 'sequential')),
  message text check (message is null or char_length(message) <= 1000),
  due_on date,
  -- sent -> in_progress (someone has signed) -> signed (everyone has; awaiting the
  -- seal) -> completed. voided from any state before completed.
  status text not null default 'sent' check (status in ('sent', 'in_progress', 'signed', 'completed', 'voided')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- sealing
  seal_started_at timestamptz,
  seal_error text,
  sealed_at timestamptz,
  sealed_path text,
  sealed_sha256 text check (sealed_sha256 is null or sealed_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256 text check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),
  document_id uuid references public.documents(id) on delete set null,
  -- voiding
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text,
  constraint sign_requests_sealed_shape check ((status = 'completed') = (sealed_sha256 is not null)),
  constraint sign_requests_voided_shape check ((status = 'voided') = (voided_at is not null))
);
create index sign_requests_family_idx on public.sign_requests (family_id);
create index sign_requests_template_idx on public.sign_requests (template_id);
create index sign_requests_status_idx on public.sign_requests (status);
-- One live request per template and household. Voiding frees the slot.
create unique index sign_requests_one_live_per_family
  on public.sign_requests (template_id, family_id) where status <> 'voided' and family_id is not null;

create table public.sign_signers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.sign_requests(id) on delete restrict,
  slot smallint not null check (slot in (1, 2)),
  -- Cleared if the person later deletes their account; the name below stays,
  -- because the sealed certificate already carries it.
  user_id uuid references public.profiles(id) on delete set null,
  display_name text not null,
  email text,
  status text not null default 'pending' check (status in ('pending', 'viewed', 'consented', 'signed')),
  viewed_at timestamptz,
  consented_at timestamptz,
  consent_text_sha256 text,
  signed_at timestamptz,
  -- { kind: 'typed', text } or { kind: 'drawn', png } (base64 PNG), and the same for initials
  signature jsonb,
  initials jsonb,
  unique (request_id, slot)
);
create index sign_signers_user_idx on public.sign_signers (user_id);

create table public.sign_field_values (
  request_id uuid not null references public.sign_requests(id) on delete restrict,
  field_id uuid not null references public.sign_fields(id) on delete restrict,
  signer_id uuid not null references public.sign_signers(id) on delete restrict,
  -- text: what was typed. date: yyyy-mm-dd. checkbox: 'true' or 'false'.
  -- signature and initials: 'adopted' (the image is on the signer row).
  value text not null check (char_length(value) <= 500),
  filled_at timestamptz not null default now(),
  primary key (request_id, field_id)
);

create table public.sign_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.sign_requests(id) on delete restrict,
  signer_id uuid references public.sign_signers(id) on delete restrict,
  action text not null check (action in (
    'created', 'sent', 'viewed', 'consent_given', 'field_filled', 'signed', 'completed',
    'voided', 'downloaded', 'reminded', 'timestamped', 'seal_failed')),
  -- Deliberately no foreign key: an append-only table cannot take the UPDATE a
  -- "set null" would need, and the certificate keeps the name anyway.
  actor_user_id uuid,
  actor_name text,
  ip text,
  user_agent text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sign_events_request_idx on public.sign_events (request_id, id);

alter table public.requirements add column if not exists sign_template_id uuid
  references public.sign_templates(id) on delete set null;

alter table public.sign_templates enable row level security;
alter table public.sign_fields enable row level security;
alter table public.sign_requests enable row level security;
alter table public.sign_signers enable row level security;
alter table public.sign_field_values enable row level security;
alter table public.sign_events enable row level security;

-- --- append-only and locked records -----------------------------------------------
create or replace function private.sign_events_append_only()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  raise exception 'The signing audit trail is append-only.' using errcode = 'P0001';
end;
$function$;

create trigger sign_events_no_change before update or delete on public.sign_events
  for each row execute function private.sign_events_append_only();
create trigger sign_events_no_truncate before truncate on public.sign_events
  for each statement execute function private.sign_events_append_only();

create trigger sign_field_values_no_change before update or delete on public.sign_field_values
  for each row execute function private.sign_events_append_only();
create trigger sign_field_values_no_truncate before truncate on public.sign_field_values
  for each statement execute function private.sign_events_append_only();

create or replace function private.sign_requests_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'A signature request is a record and cannot be deleted. Void it instead.' using errcode = 'P0001';
  end if;
  if new.template_id is distinct from old.template_id
    or new.original_path is distinct from old.original_path
    or new.original_sha256 is distinct from old.original_sha256
    or new.page_count is distinct from old.page_count
    or new.title is distinct from old.title
    or new.signing_order is distinct from old.signing_order
    or new.created_at is distinct from old.created_at then
    raise exception 'The file and terms of a sent request are locked.' using errcode = 'P0001';
  end if;
  if old.status in ('completed', 'voided') and new.status is distinct from old.status then
    raise exception 'A % request cannot change state.', old.status using errcode = 'P0001';
  end if;
  if old.sealed_sha256 is not null and (
      new.sealed_sha256 is distinct from old.sealed_sha256
      or new.sealed_path is distinct from old.sealed_path
      or new.body_sha256 is distinct from old.body_sha256) then
    raise exception 'A sealed record cannot be replaced.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
create trigger sign_requests_guard before update or delete on public.sign_requests
  for each row execute function private.sign_requests_guard();

create or replace function private.sign_signers_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'A signer is part of the record and cannot be deleted.' using errcode = 'P0001';
  end if;
  if new.request_id is distinct from old.request_id or new.slot is distinct from old.slot then
    raise exception 'A signer cannot be moved.' using errcode = 'P0001';
  end if;
  if old.status = 'signed' and (
      new.status is distinct from old.status
      or new.signature is distinct from old.signature
      or new.initials is distinct from old.initials
      or new.signed_at is distinct from old.signed_at
      or new.consented_at is distinct from old.consented_at
      or new.consent_text_sha256 is distinct from old.consent_text_sha256
      or new.display_name is distinct from old.display_name) then
    raise exception 'A completed signature cannot be changed.' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
create trigger sign_signers_guard before update or delete on public.sign_signers
  for each row execute function private.sign_signers_guard();

-- Fields and the file are frozen the moment a template has been sent.
create or replace function private.sign_fields_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
declare v_template uuid;
begin
  v_template := case when tg_op = 'DELETE' then old.template_id else new.template_id end;
  if exists (select 1 from public.sign_requests where template_id = v_template) then
    raise exception 'This document has been sent, so its fields are locked. Make a copy to change them.' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
create trigger sign_fields_guard before insert or update or delete on public.sign_fields
  for each row execute function private.sign_fields_guard();

create or replace function private.sign_templates_guard()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  if new.storage_path is distinct from old.storage_path or new.sha256 is distinct from old.sha256
     or new.page_count is distinct from old.page_count then
    if exists (select 1 from public.sign_requests where template_id = old.id) then
      raise exception 'This document has been sent, so its file is locked.' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
create trigger sign_templates_guard before update on public.sign_templates
  for each row execute function private.sign_templates_guard();

-- --- helpers ------------------------------------------------------------------------
-- The consent statement. It lives in the database so the text recorded with a
-- person's consent is exactly the text the database holds, not whatever a
-- browser claims it showed.
create or replace function public.sign_consent_text()
returns text
language sql immutable set search_path to ''
as $function$
  select 'I agree to sign this document electronically. I understand that my typed or drawn signature, '
    || 'and my initials, are my legal signature and have the same effect as a handwritten one. '
    || 'I agree to receive this document and its signed copy as electronic records, and I can save and print them. '
    || 'I can ask Veritas Village for a paper copy at any time. I can decline to sign electronically by not signing, '
    || 'and I can ask the co-op to arrange a paper signature instead. I have a device, a browser and a PDF viewer '
    || 'that let me read this document. My name, the time, my IP address and my browser details are recorded when I sign.';
$function$;

create or replace function private.sign_consent_hash()
returns text
language sql immutable set search_path to ''
as $function$
  select encode(sha256(convert_to(public.sign_consent_text(), 'UTF8')), 'hex');
$function$;

-- The caller's address, as the platform in front of the database saw it. The
-- browser cannot choose these; they come from the request headers.
create or replace function private.request_ip()
returns text
language sql stable set search_path to ''
as $function$
  select left(nullif(btrim(coalesce(
    h ->> 'cf-connecting-ip',
    h ->> 'x-real-ip',
    split_part(h ->> 'x-forwarded-for', ',', 1))), ''), 64)
  from (select coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb) as h) s;
$function$;

create or replace function private.request_user_agent()
returns text
language sql stable set search_path to ''
as $function$
  select left(nullif(btrim(h ->> 'user-agent'), ''), 400)
  from (select coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb) as h) s;
$function$;

create or replace function private.sign_log(p_request uuid, p_signer uuid, p_action text, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_name text;
begin
  select coalesce(nullif(btrim(display_name), ''), email) into v_name from public.profiles where id = v_actor;
  insert into public.sign_events (request_id, signer_id, action, actor_user_id, actor_name, ip, user_agent, detail)
  values (p_request, p_signer, p_action, v_actor, case when v_actor is null then 'System' else coalesce(v_name, 'Unknown') end,
    private.request_ip(), private.request_user_agent(), coalesce(p_detail, '{}'::jsonb));
end;
$function$;

-- Why a person cannot sign yet, as codes the app turns into plain sentences.
-- Empty means they can. The session check (aal2) only applies to the caller's
-- own session; for anyone else the account-setup checks are all that can be known.
create or replace function private.signing_blockers(p_user uuid)
returns text[]
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_blockers text[] := '{}';
  v_profile record;
  v_confirmed timestamptz;
  v_enrolled boolean;
begin
  select p.status, p.display_name, p.email into v_profile from public.profiles p where p.id = p_user;
  if not found or v_profile.status <> 'active' then return array['account_not_active']; end if;

  select u.email_confirmed_at into v_confirmed from auth.users u
  where u.id = p_user and (u.banned_until is null or u.banned_until < now());
  if not found then return array['account_not_active']; end if;

  -- Accepting an invitation is what confirms the email address
  -- (see 20261105144838_invitation_accepted_tracking.sql).
  if v_confirmed is null
     or (exists (select 1 from public.invitations i where lower(i.email) = lower(v_profile.email) and i.accepted_at is null)
         and not exists (select 1 from public.invitations i where lower(i.email) = lower(v_profile.email) and i.accepted_at is not null)) then
    v_blockers := array_append(v_blockers, 'invitation_not_accepted'::text);
  end if;

  if btrim(coalesce(v_profile.display_name, '')) = '' then
    v_blockers := array_append(v_blockers, 'profile_incomplete'::text);
  end if;

  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified') into v_enrolled;
  if not v_enrolled then
    v_blockers := array_append(v_blockers, 'mfa_not_enrolled'::text);
  elsif p_user = (select auth.uid()) and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    v_blockers := array_append(v_blockers, 'mfa_not_verified'::text);
  end if;

  return v_blockers;
end;
$function$;

create or replace function private.sign_require_eligible()
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_blockers text[];
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.' using errcode = 'P0001'; end if;
  v_blockers := private.signing_blockers((select auth.uid()));
  if cardinality(v_blockers) > 0 then
    raise exception 'Finish setting up your account before signing.' using errcode = 'P0001', detail = array_to_string(v_blockers, ',');
  end if;
end;
$function$;

create or replace function public.sign_eligibility()
returns jsonb
language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object(
    'eligible', cardinality(b) = 0,
    'blockers', to_jsonb(b))
  from (select case when (select auth.uid()) is null then array['account_not_active']
                    else private.signing_blockers((select auth.uid())) end as b) s;
$function$;

create or replace function private.sign_require_admin()
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.has_role('admin') then raise exception 'Administrator access is required.' using errcode = 'P0001'; end if;
  if not private.aal_satisfied() then raise exception 'Complete two-factor verification first.' using errcode = 'P0001'; end if;
end;
$function$;

create or replace function private.sign_request_visible(p_request uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.is_active_user() and exists (
    select 1 from public.sign_requests r
    where r.id = p_request
      and (private.has_role('admin')
        or exists (select 1 from public.sign_signers s where s.request_id = r.id and s.user_id = (select auth.uid()))
        or (r.family_id is not null and private.has_family_access(r.family_id))));
$function$;

-- A file under sign/ is readable by an administrator, or by the people on the
-- request it belongs to: the original while the template has a visible request,
-- and everything under sign/requests/<id>/ (sealed PDF, timestamp) for that request.
create or replace function private.can_read_sign_file(p_name text)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.is_active_user() and (
    private.has_role('admin')
    or (p_name ~ '^sign/requests/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' and private.sign_request_visible(
          substring(p_name from '^sign/requests/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid))
    or (p_name ~ '^sign/templates/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' and exists (
          select 1 from public.sign_requests r
          where r.template_id = substring(p_name from '^sign/templates/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/')::uuid
            and private.sign_request_visible(r.id)))
  );
$function$;

revoke all on function private.sign_events_append_only(), private.sign_requests_guard(), private.sign_signers_guard(),
  private.sign_fields_guard(), private.sign_templates_guard(), private.sign_consent_hash(), private.request_ip(),
  private.request_user_agent(), private.sign_log(uuid, uuid, text, jsonb), private.signing_blockers(uuid),
  private.sign_require_eligible(), private.sign_require_admin() from public, anon, authenticated;
revoke all on function private.sign_request_visible(uuid), private.can_read_sign_file(text) from public, anon;
grant execute on function private.sign_request_visible(uuid), private.can_read_sign_file(text) to authenticated;

-- --- policies (reads only; every write goes through a function) ------------------------
create policy sign_templates_admin_read on public.sign_templates
  for select to authenticated using (private.has_role('admin'));

create policy sign_fields_read on public.sign_fields
  for select to authenticated using (
    private.has_role('admin')
    or exists (select 1 from public.sign_requests r
               where r.template_id = sign_fields.template_id and private.sign_request_visible(r.id)));

create policy sign_requests_read on public.sign_requests
  for select to authenticated using (private.sign_request_visible(id));

create policy sign_signers_read on public.sign_signers
  for select to authenticated using (private.sign_request_visible(request_id));

create policy sign_field_values_read on public.sign_field_values
  for select to authenticated using (private.sign_request_visible(request_id));

create policy sign_events_read on public.sign_events
  for select to authenticated using (private.sign_request_visible(request_id));

-- Same blanket rule the rest of the tables carry (20260827120819): a session
-- that has not stepped up to its second factor reads nothing.
create policy aal2_required on public.sign_templates as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.sign_fields as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.sign_requests as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.sign_signers as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.sign_field_values as restrictive for all to authenticated using (private.aal_satisfied());
create policy aal2_required on public.sign_events as restrictive for all to authenticated using (private.aal_satisfied());

grant select on public.sign_templates, public.sign_fields, public.sign_requests, public.sign_signers,
  public.sign_field_values, public.sign_events to authenticated;
-- The audit trail and the filled values can never be changed or removed, by anyone.
revoke update, delete, truncate on public.sign_events, public.sign_field_values from public, anon, authenticated, service_role;
revoke insert on public.sign_events, public.sign_field_values from public, anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.sign_templates, public.sign_fields, public.sign_requests,
  public.sign_signers from public, anon, authenticated;

create policy sign_files_read on storage.objects for select to authenticated using (
  bucket_id = 'family-village-private' and name like 'sign/%' and private.can_read_sign_file(name));

-- --- administrators: templates and fields ---------------------------------------------
-- The PDF is uploaded to sign/templates/<id>/original.pdf first (administrators
-- may already upload anywhere in the bucket), then registered here. The caller
-- supplies the SHA-256 it computed; the sealing function recomputes it from the
-- stored bytes and refuses to proceed on a mismatch.
create or replace function public.sign_create_template(p_id uuid, p_title text, p_page_count integer, p_sha256 text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_path text := 'sign/templates/' || p_id::text || '/original.pdf';
begin
  perform private.sign_require_admin();
  if not exists (select 1 from storage.objects where bucket_id = 'family-village-private' and name = v_path) then
    raise exception 'Upload the PDF first.' using errcode = 'P0001';
  end if;
  insert into public.sign_templates (id, title, storage_path, sha256, page_count, created_by)
  values (p_id, btrim(p_title), v_path, lower(p_sha256), p_page_count, (select auth.uid()));
  return p_id;
end;
$function$;

-- Replaces every field on a template. p_fields is an array of
-- { page, x, y, w, h, kind, slot, required, label }. Refused once the template
-- has been sent.
create or replace function public.sign_save_fields(p_template uuid, p_title text, p_fields jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_t public.sign_templates;
  v_f jsonb;
  v_max smallint := 0;
  v_slot smallint;
begin
  perform private.sign_require_admin();
  select * into v_t from public.sign_templates where id = p_template for update;
  if not found then raise exception 'That document does not exist.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.sign_requests where template_id = p_template) then
    raise exception 'This document has been sent, so its fields are locked. Make a copy to change them.' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_fields, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_fields, '[]'::jsonb)) > 200 then
    raise exception 'A document can have up to 200 fields.' using errcode = 'P0001';
  end if;

  delete from public.sign_fields where template_id = p_template;
  for v_f in select * from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) loop
    if (v_f ->> 'page')::int > v_t.page_count then
      raise exception 'A field is on page %, but the document has % pages.', v_f ->> 'page', v_t.page_count using errcode = 'P0001';
    end if;
    v_slot := (v_f ->> 'slot')::smallint;
    insert into public.sign_fields (template_id, page, x, y, w, h, kind, signer_slot, required, label)
    values (p_template, (v_f ->> 'page')::int, (v_f ->> 'x')::float8, (v_f ->> 'y')::float8,
      (v_f ->> 'w')::float8, (v_f ->> 'h')::float8, v_f ->> 'kind', v_slot,
      coalesce((v_f ->> 'required')::boolean, true), nullif(btrim(v_f ->> 'label'), ''));
    v_max := greatest(v_max, v_slot);
  end loop;

  -- Slot 2 only makes sense next to slot 1, and each slot in use must be able to sign.
  if v_max = 2 and not exists (select 1 from public.sign_fields where template_id = p_template and signer_slot = 1) then
    raise exception 'Signer 2 needs a signer 1 on the same document.' using errcode = 'P0001';
  end if;
  update public.sign_templates
  set title = coalesce(nullif(btrim(p_title), ''), title),
      signers_required = greatest(v_max, 1),
      status = case
        when v_max = 0 then 'draft'
        when (select count(distinct signer_slot) from public.sign_fields where template_id = p_template and kind = 'signature') = v_max then 'ready'
        else 'draft' end
  where id = p_template;
end;
$function$;

create or replace function public.sign_archive_template(p_template uuid, p_archived boolean default true)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.sign_require_admin();
  update public.sign_templates
  set status = case when p_archived then 'archived'
                    when exists (select 1 from public.sign_fields where template_id = p_template) then 'ready' else 'draft' end
  where id = p_template;
end;
$function$;

-- --- administrators: sending, reminding, voiding -----------------------------------------
-- Sends a template to households. Target households come from p_family_ids, or,
-- when that is null, from the households that still owe p_requirement. Signers
-- are the first adults by when they joined the household, unless p_assignments
-- names them: { "<family_id>": ["<user_id>", ...] } in slot order.
create or replace function public.sign_send(
  p_template uuid,
  p_family_ids uuid[] default null,
  p_requirement uuid default null,
  p_sequential boolean default false,
  p_message text default null,
  p_due_on date default null,
  p_assignments jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_t public.sign_templates;
  v_req public.requirements;
  v_family uuid;
  v_targets uuid[];
  v_users uuid[];
  v_user uuid;
  v_request uuid;
  v_fr uuid;
  v_fr_status text;
  v_slot int;
  v_sent jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_message text := nullif(btrim(coalesce(p_message, '')), '');
begin
  perform private.sign_require_admin();
  select * into v_t from public.sign_templates where id = p_template for update;
  if not found then raise exception 'That document does not exist.' using errcode = 'P0001'; end if;
  if v_t.status <> 'ready' then
    raise exception 'Place a signature field for each signer before sending.' using errcode = 'P0001';
  end if;
  if v_message is not null and char_length(v_message) > 1000 then
    raise exception 'The note can be up to 1000 characters.' using errcode = 'P0001';
  end if;

  if p_requirement is not null then
    select * into v_req from public.requirements where id = p_requirement;
    if not found or v_req.kind <> 'document' then
      raise exception 'Pick a required document.' using errcode = 'P0001';
    end if;
    if v_req.sign_template_id is not null and v_req.sign_template_id <> p_template then
      raise exception 'That requirement already uses a different document.' using errcode = 'P0001';
    end if;
    update public.requirements set sign_template_id = p_template where id = p_requirement and sign_template_id is null;
  end if;

  if p_family_ids is not null then
    v_targets := p_family_ids;
  elsif p_requirement is not null then
    select coalesce(array_agg(family_id), '{}') into v_targets
    from public.family_requirements where requirement_id = p_requirement and status in ('outstanding', 'sent');
  else
    raise exception 'Choose households, or a requirement to send to.' using errcode = 'P0001';
  end if;

  foreach v_family in array v_targets loop
    if not exists (select 1 from public.families where id = v_family) then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'unknown_household');
      continue;
    end if;
    if exists (select 1 from public.sign_requests where template_id = p_template and family_id = v_family and status <> 'voided') then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_sent');
      continue;
    end if;

    if p_assignments ? v_family::text then
      select array_agg(u::uuid order by o) into v_users
      from jsonb_array_elements_text(p_assignments -> v_family::text) with ordinality as e(u, o);
    else
      select array_agg(user_id order by created_at, user_id) into v_users from (
        select fm.user_id, fm.created_at
        from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
        where fm.family_id = v_family
        order by fm.created_at, fm.user_id limit v_t.signers_required) x;
    end if;
    if coalesce(cardinality(v_users), 0) <> v_t.signers_required then
      v_skipped := v_skipped || jsonb_build_object('family_id', v_family,
        'reason', case when v_t.signers_required = 2 then 'needs_two_adults' else 'no_adult' end);
      continue;
    end if;
    if exists (
      select 1 from unnest(v_users) u
      where not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id and p.status = 'active'
                        where fm.family_id = v_family and fm.user_id = u)) then
      raise exception 'Every signer must be an active adult in that household.' using errcode = 'P0001';
    end if;
    if cardinality(v_users) = 2 and v_users[1] = v_users[2] then
      raise exception 'Choose two different people.' using errcode = 'P0001';
    end if;

    v_fr := null;
    if p_requirement is not null then
      select id, status into v_fr, v_fr_status from public.family_requirements
      where requirement_id = p_requirement and family_id = v_family;
      if v_fr_status = 'complete' or v_fr_status = 'waived' then
        v_skipped := v_skipped || jsonb_build_object('family_id', v_family, 'reason', 'already_' || v_fr_status);
        continue;
      end if;
      if v_fr is null then
        insert into public.family_requirements (requirement_id, family_id, status, updated_by)
        values (p_requirement, v_family, 'sent', v_me) returning id into v_fr;
      else
        update public.family_requirements set status = 'sent', updated_by = v_me where id = v_fr;
      end if;
    end if;

    insert into public.sign_requests (template_id, family_id, requirement_id, family_requirement_id, title,
      original_path, original_sha256, page_count, signing_order, message, due_on, created_by)
    values (p_template, v_family, p_requirement, v_fr, v_t.title, v_t.storage_path, v_t.sha256, v_t.page_count,
      case when p_sequential then 'sequential' else 'any' end, v_message, p_due_on, v_me)
    returning id into v_request;

    v_slot := 0;
    foreach v_user in array v_users loop
      v_slot := v_slot + 1;
      insert into public.sign_signers (request_id, slot, user_id, display_name, email)
      select v_request, v_slot, p.id, coalesce(nullif(btrim(p.display_name), ''), split_part(p.email, '@', 1)), p.email
      from public.profiles p where p.id = v_user;
    end loop;

    perform private.sign_log(v_request, null, 'created', jsonb_build_object('title', v_t.title, 'template_id', p_template, 'original_sha256', v_t.sha256));
    perform private.sign_log(v_request, null, 'sent', jsonb_build_object('signers', v_users, 'signing_order', case when p_sequential then 'sequential' else 'any' end));

    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    select s.user_id, 'sign_request', 'Please sign: ' || v_t.title,
      coalesce(v_message, 'Veritas Village is asking you to sign this document.'),
      '/family-village/paperwork', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.user_id is not null;
    insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
    select s.email, 'Please sign: ' || v_t.title,
      '<p>Veritas Village is asking you to sign <strong>' || private.escape_html(v_t.title) || '</strong>.</p>'
        || coalesce('<p>' || private.escape_html(v_message) || '</p>', '')
        || '<p>Sign in to Family Village and open Paperwork to read and sign it: <a href="https://family.veritasvillage.org/family-village/paperwork">family.veritasvillage.org</a></p>',
      'sign_request', 'sign_request', v_request
    from public.sign_signers s where s.request_id = v_request and s.email is not null and s.email <> '';

    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (v_me, 'sign_request_sent', 'sign_request', v_request::text, jsonb_build_object('title', v_t.title, 'family_id', v_family));

    v_sent := v_sent || jsonb_build_object('request_id', v_request, 'family_id', v_family);
  end loop;

  return jsonb_build_object('sent', v_sent, 'skipped', v_skipped);
end;
$function$;

create or replace function public.sign_remind(p_request uuid)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare
  v_r public.sign_requests;
  v_s record;
  v_count integer := 0;
begin
  perform private.sign_require_admin();
  select * into v_r from public.sign_requests where id = p_request;
  if not found then raise exception 'That request does not exist.' using errcode = 'P0001'; end if;
  if v_r.status not in ('sent', 'in_progress') then
    raise exception 'Only requests that are waiting for a signature can be reminded.' using errcode = 'P0001';
  end if;

  for v_s in
    select s.* from public.sign_signers s
    where s.request_id = p_request and s.status <> 'signed' and s.user_id is not null
      and not exists (select 1 from public.sign_events e
                      where e.signer_id = s.id and e.action = 'reminded' and e.created_at > now() - interval '1 hour')
      -- In sequential order the second signer is not asked until the first has signed.
      and (v_r.signing_order = 'any' or s.slot = 1 or exists (
            select 1 from public.sign_signers a where a.request_id = p_request and a.slot = 1 and a.status = 'signed'))
  loop
    insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
    values (v_s.user_id, 'sign_request', 'Reminder: please sign ' || v_r.title,
      'This is still waiting for your signature.', '/family-village/paperwork', 'sign_request', p_request);
    if v_s.email is not null and v_s.email <> '' then
      insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
      values (v_s.email, 'Reminder: please sign ' || v_r.title,
        '<p><strong>' || private.escape_html(v_r.title) || '</strong> is still waiting for your signature.</p>'
          || '<p>Sign in to Family Village and open Paperwork: <a href="https://family.veritasvillage.org/family-village/paperwork">family.veritasvillage.org</a></p>',
        'sign_request', 'sign_request', p_request);
    end if;
    perform private.sign_log(p_request, v_s.id, 'reminded', '{}'::jsonb);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function public.sign_void(p_request uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_r public.sign_requests;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.sign_require_admin();
  if char_length(v_reason) not between 1 and 500 then
    raise exception 'Say briefly why (up to 500 characters).' using errcode = 'P0001';
  end if;
  select * into v_r from public.sign_requests where id = p_request for update;
  if not found then raise exception 'That request does not exist.' using errcode = 'P0001'; end if;
  if v_r.status = 'completed' then
    raise exception 'A sealed record cannot be voided.' using errcode = 'P0001';
  end if;
  if v_r.status = 'voided' then return; end if;

  update public.sign_requests set status = 'voided', voided_at = now(), voided_by = v_me, void_reason = v_reason where id = p_request;
  -- The household owes the document again.
  update public.family_requirements set status = 'outstanding', updated_by = v_me
  where id = v_r.family_requirement_id and status = 'sent';

  perform private.sign_log(p_request, null, 'voided', jsonb_build_object('reason', v_reason));
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select s.user_id, 'sign_request', 'Signing cancelled: ' || v_r.title, v_reason, '/family-village/paperwork', 'sign_request', p_request
  from public.sign_signers s where s.request_id = p_request and s.user_id is not null;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_me, 'sign_request_voided', 'sign_request', p_request::text, jsonb_build_object('title', v_r.title, 'reason', v_reason));
end;
$function$;

-- --- signers ------------------------------------------------------------------------------
-- Opening the document. Logged once per half hour per person.
create or replace function public.sign_record_view(p_request uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_s public.sign_signers;
begin
  select s.* into v_s from public.sign_signers s join public.sign_requests r on r.id = s.request_id
  where s.request_id = p_request and s.user_id = (select auth.uid()) and r.status in ('sent', 'in_progress', 'signed', 'completed');
  if not found then return; end if;
  if not private.aal_satisfied() then return; end if;
  if v_s.status = 'pending' then
    update public.sign_signers set status = 'viewed', viewed_at = now() where id = v_s.id;
  elsif v_s.viewed_at is null then
    update public.sign_signers set viewed_at = now() where id = v_s.id;
  end if;
  if not exists (select 1 from public.sign_events e where e.signer_id = v_s.id and e.action = 'viewed' and e.created_at > now() - interval '30 minutes') then
    perform private.sign_log(p_request, v_s.id, 'viewed', '{}'::jsonb);
  end if;
end;
$function$;

create or replace function public.sign_give_consent(p_request uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_s public.sign_signers; v_r public.sign_requests;
begin
  perform private.sign_require_eligible();
  select * into v_r from public.sign_requests where id = p_request for update;
  select * into v_s from public.sign_signers where request_id = p_request and user_id = (select auth.uid());
  if v_r.id is null or v_s.id is null or v_r.status not in ('sent', 'in_progress') then
    raise exception 'There is nothing for you to sign here.' using errcode = 'P0001';
  end if;
  if v_s.status = 'signed' then raise exception 'You have already signed.' using errcode = 'P0001'; end if;
  if v_r.family_id is not null and not private.has_family_access(v_r.family_id) then
    raise exception 'You are no longer an adult in this household.' using errcode = 'P0001';
  end if;
  update public.sign_signers
  set status = 'consented', consented_at = now(), consent_text_sha256 = private.sign_consent_hash()
  where id = v_s.id;
  perform private.sign_log(p_request, v_s.id, 'consent_given',
    jsonb_build_object('consent_text', public.sign_consent_text(), 'consent_text_sha256', private.sign_consent_hash()));
end;
$function$;

-- Signs. p_signature / p_initials are { kind: 'typed', text } or { kind: 'drawn', png };
-- p_values maps a field id to what the person entered for text and checkbox fields.
-- Dates are filled in by the database, never taken from the browser.
create or replace function public.sign_submit(p_request uuid, p_signature jsonb, p_initials jsonb, p_values jsonb)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := (select auth.uid());
  v_r public.sign_requests;
  v_s public.sign_signers;
  v_f record;
  v_val text;
  v_today text := to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD');
  v_sig jsonb;
  v_unsigned integer;
  v_status text;
  v_profile_name text;
  v_key text;
begin
  perform private.sign_require_eligible();
  select * into v_r from public.sign_requests where id = p_request for update;
  select * into v_s from public.sign_signers where request_id = p_request and user_id = v_me for update;
  if v_r.id is null or v_s.id is null or v_r.status not in ('sent', 'in_progress') then
    raise exception 'There is nothing for you to sign here.' using errcode = 'P0001';
  end if;
  if v_s.status = 'signed' then raise exception 'You have already signed.' using errcode = 'P0001'; end if;
  if v_r.family_id is not null and not private.has_family_access(v_r.family_id) then
    raise exception 'You are no longer an adult in this household.' using errcode = 'P0001';
  end if;
  if v_s.consented_at is null or v_s.consent_text_sha256 is distinct from private.sign_consent_hash() then
    raise exception 'Agree to sign electronically first.' using errcode = 'P0001';
  end if;
  if v_r.signing_order = 'sequential' and exists (
      select 1 from public.sign_signers o where o.request_id = p_request and o.slot < v_s.slot and o.status <> 'signed') then
    raise exception 'The other signer goes first.' using errcode = 'P0001';
  end if;

  p_values := coalesce(p_values, '{}'::jsonb);
  if jsonb_typeof(p_values) <> 'object' then raise exception 'Those answers could not be read.' using errcode = 'P0001'; end if;
  for v_key in select jsonb_object_keys(p_values) loop
    if not exists (select 1 from public.sign_fields f
                   where f.id::text = v_key and f.template_id = v_r.template_id and f.signer_slot = v_s.slot
                     and f.kind in ('text', 'checkbox')) then
      raise exception 'Those answers do not match this document.' using errcode = 'P0001';
    end if;
  end loop;

  -- The signature and initials the person adopts.
  v_sig := p_signature;
  if exists (select 1 from public.sign_fields f where f.template_id = v_r.template_id and f.signer_slot = v_s.slot and f.kind = 'signature') then
    if v_sig is null or jsonb_typeof(v_sig) <> 'object' then raise exception 'Add your signature.' using errcode = 'P0001'; end if;
  end if;
  perform private.sign_check_mark(p_signature, 'signature');
  perform private.sign_check_mark(p_initials, 'initials');
  if exists (select 1 from public.sign_fields f where f.template_id = v_r.template_id and f.signer_slot = v_s.slot and f.kind = 'initials')
     and (p_initials is null or jsonb_typeof(p_initials) <> 'object') then
    raise exception 'Add your initials.' using errcode = 'P0001';
  end if;

  for v_f in
    select * from public.sign_fields f where f.template_id = v_r.template_id and f.signer_slot = v_s.slot order by f.page, f.y, f.x
  loop
    if v_f.kind in ('signature', 'initials') then
      v_val := 'adopted';
    elsif v_f.kind = 'date' then
      v_val := v_today;
    elsif v_f.kind = 'checkbox' then
      v_val := case when lower(coalesce(p_values ->> v_f.id::text, 'false')) in ('true', 't', '1', 'yes') then 'true' else 'false' end;
      if v_f.required and v_val <> 'true' then
        raise exception 'Tick every required box%.', coalesce(' (' || v_f.label || ')', '') using errcode = 'P0001';
      end if;
    else
      v_val := btrim(coalesce(p_values ->> v_f.id::text, ''));
      if v_f.required and v_val = '' then
        raise exception 'Fill in every required field%.', coalesce(' (' || v_f.label || ')', '') using errcode = 'P0001';
      end if;
      if char_length(v_val) > 300 or v_val ~ '[\x00-\x08\x0b\x0c\x0e-\x1f]' then
        raise exception 'One of your answers is too long or has characters that cannot be used.' using errcode = 'P0001';
      end if;
      if v_val = '' then continue; end if;
    end if;
    insert into public.sign_field_values (request_id, field_id, signer_id, value) values (p_request, v_f.id, v_s.id, v_val);
    perform private.sign_log(p_request, v_s.id, 'field_filled', jsonb_build_object('field_id', v_f.id, 'kind', v_f.kind, 'page', v_f.page));
  end loop;

  select coalesce(nullif(btrim(display_name), ''), email) into v_profile_name from public.profiles where id = v_me;
  update public.sign_signers
  set status = 'signed', signed_at = now(), signature = p_signature, initials = p_initials, display_name = coalesce(v_profile_name, display_name)
  where id = v_s.id;

  select count(*) into v_unsigned from public.sign_signers where request_id = p_request and status <> 'signed';
  v_status := case when v_unsigned = 0 then 'signed' else 'in_progress' end;
  update public.sign_requests set status = v_status where id = p_request;

  perform private.sign_log(p_request, v_s.id, 'signed', jsonb_build_object(
    'slot', v_s.slot,
    'signature_kind', p_signature ->> 'kind',
    'signature_text', case when p_signature ->> 'kind' = 'typed' then p_signature ->> 'text' end,
    'account_name', v_profile_name,
    'all_signed', v_unsigned = 0));

  -- Tell the other signer, and the person who sent it, that someone has signed.
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select o.user_id, 'sign_request', v_profile_name || ' signed ' || v_r.title,
    case when v_unsigned = 0 then 'Everyone has signed. The signed copy is being prepared.' else 'It is waiting for you.' end,
    '/family-village/paperwork', 'sign_request', p_request
  from public.sign_signers o where o.request_id = p_request and o.id <> v_s.id and o.user_id is not null and o.status <> 'signed'
    and (v_r.signing_order = 'any' or o.slot > v_s.slot);

  return jsonb_build_object('status', v_status, 'all_signed', v_unsigned = 0);
end;
$function$;

-- A signature or initials mark: typed text, or a small base64 PNG drawn on screen.
create or replace function private.sign_check_mark(p_mark jsonb, p_what text)
returns void
language plpgsql immutable set search_path to ''
as $function$
declare v_text text;
begin
  if p_mark is null or p_mark = 'null'::jsonb then return; end if;
  if jsonb_typeof(p_mark) <> 'object' then raise exception 'Your % could not be read.', p_what using errcode = 'P0001'; end if;
  if p_mark ->> 'kind' = 'typed' then
    v_text := btrim(coalesce(p_mark ->> 'text', ''));
    if char_length(v_text) not between 1 and 80 or v_text ~ '[\x00-\x1f]' then
      raise exception 'Type your % (up to 80 characters).', p_what using errcode = 'P0001';
    end if;
  elsif p_mark ->> 'kind' = 'drawn' then
    v_text := coalesce(p_mark ->> 'png', '');
    -- A PNG always starts with these bytes, which is iVBORw0KGgo in base64.
    if char_length(v_text) not between 100 and 200000 or v_text !~ '^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$' then
      raise exception 'Your drawn % could not be read. Try again or type it instead.', p_what using errcode = 'P0001';
    end if;
  else
    raise exception 'Your % could not be read.', p_what using errcode = 'P0001';
  end if;
end;
$function$;

-- Download receipts. The file itself is fetched with a signed URL; this is the
-- record that someone asked for it.
create or replace function public.sign_log_download(p_request uuid, p_what text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_signer uuid;
begin
  if p_what not in ('sealed', 'original', 'timestamp') then raise exception 'Unknown file.' using errcode = 'P0001'; end if;
  if not private.sign_request_visible(p_request) or not private.aal_satisfied() then
    raise exception 'You cannot open that record.' using errcode = 'P0001';
  end if;
  select id into v_signer from public.sign_signers where request_id = p_request and user_id = (select auth.uid());
  perform private.sign_log(p_request, v_signer, 'downloaded', jsonb_build_object('file', p_what));
end;
$function$;

-- --- the sealing service (service role only) -------------------------------------------------
-- Claims a fully signed request for sealing, so two callers cannot seal it at once.
-- A claim older than ten minutes is treated as abandoned and can be taken again.
create or replace function public.sign_claim_seal(p_request uuid)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare v_claimed integer;
begin
  update public.sign_requests
  set seal_started_at = now(), seal_error = null
  where id = p_request and status = 'signed'
    and (seal_started_at is null or seal_started_at < now() - interval '10 minutes');
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$function$;

create or replace function public.sign_mark_seal_failed(p_request uuid, p_error text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.sign_requests set seal_started_at = null, seal_error = left(coalesce(p_error, 'unknown'), 500)
  where id = p_request and status = 'signed';
  perform private.sign_log(p_request, null, 'seal_failed', jsonb_build_object('error', left(coalesce(p_error, 'unknown'), 500)));
end;
$function$;

-- Records the sealed PDF, files it as the family's signed document, marks the
-- requirement complete and tells everyone involved.
create or replace function public.sign_complete(p_request uuid, p_sealed_sha256 text, p_body_sha256 text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_r public.sign_requests;
  v_path text;
  v_doc uuid;
  v_last record;
begin
  select * into v_r from public.sign_requests where id = p_request for update;
  if not found then raise exception 'That request does not exist.' using errcode = 'P0001'; end if;
  if v_r.status = 'completed' then
    if v_r.sealed_sha256 = lower(p_sealed_sha256) then return v_r.document_id; end if;
    raise exception 'Already sealed with a different file.' using errcode = 'P0001';
  end if;
  if v_r.status <> 'signed' then raise exception 'Not everyone has signed yet.' using errcode = 'P0001'; end if;

  v_path := 'sign/requests/' || p_request::text || '/sealed.pdf';
  if not exists (select 1 from storage.objects where bucket_id = 'family-village-private' and name = v_path) then
    raise exception 'The sealed file has not been stored.' using errcode = 'P0001';
  end if;

  insert into public.documents (family_id, kind, title, storage_path, signature_provider, signature_status)
  values (v_r.family_id, 'signed', v_r.title || ' (signed)', v_path, 'in_app', 'signed')
  returning id into v_doc;

  update public.sign_requests
  set status = 'completed', sealed_at = now(), sealed_path = v_path, sealed_sha256 = lower(p_sealed_sha256),
      body_sha256 = lower(p_body_sha256), document_id = v_doc, seal_started_at = null, seal_error = null
  where id = p_request;

  select s.user_id into v_last from public.sign_signers s where s.request_id = p_request order by s.signed_at desc limit 1;
  update public.family_requirements
  set status = 'complete', signed_document_id = v_doc, signed_at = now(), signed_by_user_id = v_last.user_id
  where id = v_r.family_requirement_id;

  perform private.sign_log(p_request, null, 'completed', jsonb_build_object(
    'original_sha256', v_r.original_sha256, 'body_sha256', lower(p_body_sha256), 'sealed_sha256', lower(p_sealed_sha256)));

  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select u, 'sign_request', 'Signed: ' || v_r.title, 'The signed copy and its certificate are ready.', '/family-village/paperwork', 'sign_request', p_request
  from (select s.user_id as u from public.sign_signers s where s.request_id = p_request and s.user_id is not null
        union select v_r.created_by where v_r.created_by is not null
        union select r.user_id from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active' where r.role = 'admin') people
  join public.profiles pr on pr.id = people.u and pr.status = 'active';

  insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
  select s.email, 'Signed: ' || v_r.title,
    '<p><strong>' || private.escape_html(v_r.title) || '</strong> has been signed by everyone.</p>'
      || '<p>The signed copy and its certificate are in Family Village under Paperwork: <a href="https://family.veritasvillage.org/family-village/paperwork">family.veritasvillage.org</a></p>',
    'sign_request', 'sign_request', p_request
  from public.sign_signers s where s.request_id = p_request and s.email is not null and s.email <> '';

  return v_doc;
end;
$function$;

create or replace function public.sign_log_timestamp(p_request uuid, p_detail jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.sign_log(p_request, null, 'timestamped', coalesce(p_detail, '{}'::jsonb));
end;
$function$;

-- --- who may call what --------------------------------------------------------------------------
revoke all on function private.sign_check_mark(jsonb, text) from public, anon, authenticated;

revoke all on function public.sign_consent_text(), public.sign_eligibility(),
  public.sign_create_template(uuid, text, integer, text), public.sign_save_fields(uuid, text, jsonb),
  public.sign_archive_template(uuid, boolean),
  public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb), public.sign_remind(uuid), public.sign_void(uuid, text),
  public.sign_record_view(uuid), public.sign_give_consent(uuid), public.sign_submit(uuid, jsonb, jsonb, jsonb),
  public.sign_log_download(uuid, text),
  public.sign_claim_seal(uuid), public.sign_mark_seal_failed(uuid, text), public.sign_complete(uuid, text, text),
  public.sign_log_timestamp(uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.sign_consent_text(), public.sign_eligibility(),
  public.sign_create_template(uuid, text, integer, text), public.sign_save_fields(uuid, text, jsonb),
  public.sign_archive_template(uuid, boolean),
  public.sign_send(uuid, uuid[], uuid, boolean, text, date, jsonb), public.sign_remind(uuid), public.sign_void(uuid, text),
  public.sign_record_view(uuid), public.sign_give_consent(uuid), public.sign_submit(uuid, jsonb, jsonb, jsonb),
  public.sign_log_download(uuid, text)
  to authenticated;

grant execute on function public.sign_claim_seal(uuid), public.sign_mark_seal_failed(uuid, text),
  public.sign_complete(uuid, text, text), public.sign_log_timestamp(uuid, jsonb) to service_role;
