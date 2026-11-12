-- Organization records vault: insurance, leases, nonprofit and tax paperwork.
-- ---------------------------------------------------------------------------
-- Administrators keep the co-op's own paperwork in one place: a record per
-- document (title, category, issuer, policy or contract number, dates, amount,
-- notes, tags) with the file kept in the private bucket under records/. Rules:
--   * administrators only, at the right two-factor level, never a reviewer
--     (demo) account; families and teachers never see any of it;
--   * a file is never overwritten: a replacement is the next version and the
--     earlier ones stay, readable, in the history;
--   * every upload, replacement, view and download is written to audit_log, and
--     a file cannot be read at all without the logged "open" step (the storage
--     policy only passes while a short-lived grant made by that step exists);
--   * a record is archived, never silently deleted. Permanent erasure is a
--     separate, deliberate step: the record must already be archived, past its
--     retention date, and the administrator must type its title;
--   * deleting a person's account never touches a record: who uploaded or
--     changed something is set to null, the record, file and history stay;
--   * the co-op's key facts (legal name, EIN, address, ...) live in a second
--     table with a change history. Sensitive ones (the EIN) are masked and are
--     read only through a function that writes an audit entry when revealed.
-- Browsers read the record tables; every change is a SECURITY DEFINER function.
--
-- How long to keep each kind of record is a question for the co-op's attorney
-- or accountant. Nothing here picks a number: retain_until is blank unless an
-- administrator sets it, and erasure is refused before that date.
-- ---------------------------------------------------------------------------

create table public.org_records (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  category text not null check (category in ('insurance', 'lease', 'nonprofit', 'tax', 'financial', 'contract', 'license', 'other')),
  issuer text check (issuer is null or char_length(issuer) <= 160),
  reference_number text check (reference_number is null or char_length(reference_number) <= 120),
  effective_on date,
  expires_on date,
  amount_cents bigint check (amount_cents is null or (amount_cents >= 0 and amount_cents < 100000000000)),
  notes text check (notes is null or char_length(notes) <= 4000),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  sensitive boolean not null default false,
  retain_until date,
  version integer not null default 1,
  archived_at timestamptz,
  archived_by uuid references public.profiles(id) on delete set null,
  archive_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_records_dates check (effective_on is null or expires_on is null or expires_on >= effective_on),
  constraint org_records_archive_shape check ((archived_at is null) = (archive_reason is null))
);
create index org_records_expires_idx on public.org_records (expires_on) where archived_at is null and expires_on is not null;
create index org_records_category_idx on public.org_records (category);

-- Every version of a record's file. The newest version_no is the current one.
create table public.org_record_files (
  id uuid primary key,
  record_id uuid not null references public.org_records(id) on delete restrict,
  version_no integer not null check (version_no >= 1),
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 20971520),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  change_note text check (change_note is null or char_length(change_note) <= 500),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (record_id, version_no),
  constraint org_record_files_path check (storage_path like 'records/' || record_id::text || '/' || id::text || '.%')
);

-- Every state a record has been in, including the first.
create table public.org_record_revisions (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.org_records(id) on delete restrict,
  version integer not null,
  snapshot jsonb not null,
  change_note text,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (record_id, version)
);

-- A file can be read only while one of these exists for the reader and the
-- path. They are made by public.admin_open_record_file, which also writes the
-- audit entry, and last two minutes.
create table public.org_record_file_grants (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  admin_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index org_record_file_grants_lookup_idx on public.org_record_file_grants (admin_id, storage_path, expires_at);

-- The co-op's key facts.
create table public.org_facts (
  key text primary key check (key ~ '^[a-z0-9_]{1,40}$'),
  label text not null check (char_length(label) between 1 and 80),
  value text check (value is null or char_length(value) <= 2000),
  sensitive boolean not null default false,
  sort_order integer not null default 100,
  version integer not null default 0,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz
);

create table public.org_fact_revisions (
  id uuid primary key default gen_random_uuid(),
  fact_key text not null references public.org_facts(key) on delete restrict,
  version integer not null,
  value text,
  change_note text,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (fact_key, version)
);

insert into public.org_facts (key, label, sensitive, sort_order) values
  ('legal_name', 'Legal name', false, 10),
  ('ein', 'EIN (federal tax ID)', true, 20),
  ('address', 'Address', false, 30),
  ('registered_agent', 'Registered agent', false, 40),
  ('fiscal_year_end', 'Fiscal year end', false, 50),
  ('insurance_carrier', 'Insurance carrier', false, 60),
  ('insurance_policy_number', 'Insurance policy number', true, 70),
  ('landlord_contact', 'Landlord contact', false, 80);

-- --- history guards ---------------------------------------------------------------------------
-- Append-only tables. The one change allowed is the "who" column going to null
-- when that person's account is deleted; nothing else is ever edited. Deleting
-- is refused unless public.admin_erase_record is running (it sets a flag that
-- lasts only for its own transaction) and the table is one it may clear.
create or replace function private.guard_records_history()
returns trigger language plpgsql set search_path to ''
as $function$
declare
  v_actor text := tg_argv[0];
  v_erasable boolean := tg_argv[1] = 'erasable';
begin
  if tg_op = 'DELETE' then
    if v_erasable and coalesce(current_setting('records.erasing', true), '') = 'on' then return old; end if;
    raise exception 'Records history is never deleted.' using errcode = '23000';
  end if;
  if (to_jsonb(new) - v_actor) = (to_jsonb(old) - v_actor) and (to_jsonb(new) ->> v_actor) is null then
    return new;
  end if;
  raise exception 'Records history is never edited.' using errcode = '23000';
end;
$function$;

create or replace function private.guard_records_delete()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if tg_argv[0] = 'erasable' and coalesce(current_setting('records.erasing', true), '') = 'on' then return old; end if;
  raise exception 'Records are archived, never deleted.' using errcode = '23000';
end;
$function$;

create trigger org_record_files_guard before update or delete on public.org_record_files
  for each row execute function private.guard_records_history('uploaded_by', 'erasable');
create trigger org_record_revisions_guard before update or delete on public.org_record_revisions
  for each row execute function private.guard_records_history('changed_by', 'erasable');
create trigger org_fact_revisions_guard before update or delete on public.org_fact_revisions
  for each row execute function private.guard_records_history('changed_by', 'never');
create trigger org_records_no_delete before delete on public.org_records
  for each row execute function private.guard_records_delete('erasable');
create trigger org_facts_no_delete before delete on public.org_facts
  for each row execute function private.guard_records_delete('never');

-- --- row-level security ----------------------------------------------------------------------
alter table public.org_records enable row level security;
alter table public.org_record_files enable row level security;
alter table public.org_record_revisions enable row level security;
alter table public.org_record_file_grants enable row level security;
alter table public.org_facts enable row level security;
alter table public.org_fact_revisions enable row level security;

create policy org_records_admin_read on public.org_records for select to authenticated using (private.has_role('admin'));
create policy org_record_files_admin_read on public.org_record_files for select to authenticated using (private.has_role('admin'));
create policy org_record_revisions_admin_read on public.org_record_revisions for select to authenticated using (private.has_role('admin'));
-- org_record_file_grants, org_facts and org_fact_revisions have no policy and no grant for
-- signed-in users: facts are read only through the functions below (which mask the EIN).

do $$
declare t text;
begin
  foreach t in array array['org_records', 'org_record_files', 'org_record_revisions', 'org_record_file_grants', 'org_facts', 'org_fact_revisions'] loop
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
    execute format('create policy no_demo_access on public.%I as restrictive for select to authenticated using (not private.is_demo_user())', t);
  end loop;
end $$;

-- Nothing is writable by browsers; only the three record tables are readable, and facts
-- and grants not at all. (A new table inherits broad default privileges locally, so say so.)
revoke all on public.org_records, public.org_record_files, public.org_record_revisions, public.org_record_file_grants,
  public.org_facts, public.org_fact_revisions from public, anon, authenticated;
grant select on public.org_records, public.org_record_files, public.org_record_revisions to authenticated;

-- --- storage: records/ in the private bucket --------------------------------------------------
-- Called from storage policies, which run as the signed-in user, so it must stay
-- executable by that role. A file is readable while a grant from the logged open
-- step exists, and for two minutes after the same administrator uploaded it:
-- storage reads the new row back when it inserts it, and it is their own upload.
create or replace function private.records_object_readable(p_name text, p_owner text, p_created timestamptz)
returns boolean language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.org_record_file_grants g
    where g.storage_path = p_name and g.admin_id = (select auth.uid()) and g.expires_at > now())
  or (p_owner is not null and p_owner = (select auth.uid())::text and p_created > now() - interval '2 minutes');
$function$;
revoke all on function private.records_object_readable(text, text, timestamptz) from public, anon;
grant execute on function private.records_object_readable(text, text, timestamptz) to authenticated;

-- Reading needs the logged open step; uploading is open to administrators at the
-- right assurance level and only to a path of the right shape.
create policy records_read on storage.objects for select to authenticated
  using (bucket_id = 'family-village-private' and name like 'records/%'
         and private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user()
         and private.records_object_readable(name, owner_id, created_at));
create policy records_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'family-village-private' and name like 'records/%'
              and private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user()
              and name ~ '^records/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|jpeg|png|webp)$');
-- Only a file no record points at can be removed (an upload that was never
-- registered, or a file left over after an erasure).
create policy records_delete on storage.objects for delete to authenticated
  using (bucket_id = 'family-village-private' and name like 'records/%'
         and private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user()
         and not exists (select 1 from public.org_record_files f where f.storage_path = name));

-- Restrictive twins: the bucket also has broader, older administrator policies
-- (made by hand, not in a migration). These make sure nothing broader opens records/.
create policy records_gate_select on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'records/%'
         or (private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user() and private.records_object_readable(name, owner_id, created_at)));
create policy records_gate_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'family-village-private' or name not like 'records/%'
              or (private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user()
                  and name ~ '^records/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|jpeg|png|webp)$'));
create policy records_gate_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'records/%');
create policy records_gate_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'records/%'
         or (private.has_role('admin') and private.aal_satisfied() and not private.is_demo_user()
             and not exists (select 1 from public.org_record_files f where f.storage_path = name)));

-- --- helpers ------------------------------------------------------------------------------
create or replace function private.require_records_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') or private.is_demo_user() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then raise exception 'Complete two-factor verification before continuing.' using errcode = '42501'; end if;
  return v;
end;
$function$;

create or replace function private.clean_record_tags(p_tags text[])
returns text[] language sql immutable set search_path to ''
as $function$
  select coalesce(array_agg(t order by t), '{}'::text[])
  from (select distinct left(lower(btrim(x)), 40) as t from unnest(coalesce(p_tags, '{}'::text[])) as x where btrim(x) <> '') s;
$function$;

create or replace function private.org_record_snapshot(r public.org_records)
returns jsonb language sql immutable set search_path to ''
as $function$
  select jsonb_build_object(
    'title', r.title, 'category', r.category, 'issuer', r.issuer, 'reference_number', r.reference_number,
    'effective_on', r.effective_on, 'expires_on', r.expires_on, 'amount_cents', r.amount_cents, 'notes', r.notes,
    'tags', to_jsonb(r.tags), 'sensitive', r.sensitive, 'retain_until', r.retain_until, 'archived', r.archived_at is not null);
$function$;

create or replace function private.mask_fact(p_value text)
returns text language sql immutable set search_path to ''
as $function$
  select case when p_value is null or p_value = '' then null
              when char_length(p_value) <= 4 then '••••'
              else '••••' || right(p_value, 4) end;
$function$;

revoke all on function private.guard_records_history() from public, anon, authenticated;
revoke all on function private.guard_records_delete() from public, anon, authenticated;
revoke all on function private.require_records_admin() from public, anon, authenticated;
revoke all on function private.clean_record_tags(text[]) from public, anon, authenticated;
revoke all on function private.org_record_snapshot(public.org_records) from public, anon, authenticated;
revoke all on function private.mask_fact(text) from public, anon, authenticated;

-- --- records: add, change, archive ---------------------------------------------------------
create or replace function public.admin_create_record(
  p_title text, p_category text, p_issuer text, p_reference text, p_effective_on date, p_expires_on date,
  p_amount_cents bigint, p_notes text, p_tags text[], p_sensitive boolean, p_retain_until date)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_id uuid;
  r public.org_records%rowtype;
begin
  if coalesce(btrim(p_title), '') = '' then raise exception 'Give the record a title.'; end if;
  if p_category is null or p_category not in ('insurance', 'lease', 'nonprofit', 'tax', 'financial', 'contract', 'license', 'other') then
    raise exception 'Choose a category.';
  end if;
  if p_effective_on is not null and p_expires_on is not null and p_expires_on < p_effective_on then
    raise exception 'The expiry date is before the effective date.';
  end if;
  insert into public.org_records (title, category, issuer, reference_number, effective_on, expires_on, amount_cents, notes, tags, sensitive, retain_until, created_by)
  values (btrim(p_title), p_category, nullif(btrim(coalesce(p_issuer, '')), ''), nullif(btrim(coalesce(p_reference, '')), ''),
          p_effective_on, p_expires_on, p_amount_cents, nullif(btrim(coalesce(p_notes, '')), ''), private.clean_record_tags(p_tags),
          coalesce(p_sensitive, p_category in ('nonprofit', 'tax', 'financial')), p_retain_until, v_actor)
  returning * into r;
  v_id := r.id;
  insert into public.org_record_revisions (record_id, version, snapshot, change_note, changed_by)
  values (v_id, 1, private.org_record_snapshot(r), 'Added', v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'record_created', 'org_record', v_id::text, jsonb_build_object('category', p_category, 'sensitive', r.sensitive));
  return v_id;
end;
$function$;

create or replace function public.admin_update_record(
  p_record uuid, p_title text, p_category text, p_issuer text, p_reference text, p_effective_on date, p_expires_on date,
  p_amount_cents bigint, p_notes text, p_tags text[], p_sensitive boolean, p_retain_until date, p_change_note text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  o public.org_records%rowtype;
  n public.org_records%rowtype;
  v_changed text[];
begin
  select * into o from public.org_records where id = p_record for update;
  if not found then raise exception 'That record does not exist.'; end if;
  if o.archived_at is not null then raise exception 'Restore an archived record before changing it.'; end if;
  if coalesce(btrim(p_change_note), '') = '' then raise exception 'Say why you are changing it.'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'Give the record a title.'; end if;
  if p_category is null or p_category not in ('insurance', 'lease', 'nonprofit', 'tax', 'financial', 'contract', 'license', 'other') then
    raise exception 'Choose a category.';
  end if;
  if p_effective_on is not null and p_expires_on is not null and p_expires_on < p_effective_on then
    raise exception 'The expiry date is before the effective date.';
  end if;
  update public.org_records
  set title = btrim(p_title), category = p_category, issuer = nullif(btrim(coalesce(p_issuer, '')), ''),
      reference_number = nullif(btrim(coalesce(p_reference, '')), ''), effective_on = p_effective_on, expires_on = p_expires_on,
      amount_cents = p_amount_cents, notes = nullif(btrim(coalesce(p_notes, '')), ''), tags = private.clean_record_tags(p_tags),
      sensitive = coalesce(p_sensitive, o.sensitive), retain_until = p_retain_until, version = o.version + 1, updated_at = now()
  where id = p_record returning * into n;
  select coalesce(array_agg(k.key order by k.key), '{}') into v_changed
  from jsonb_each(private.org_record_snapshot(n)) k where private.org_record_snapshot(o) -> k.key is distinct from k.value;
  insert into public.org_record_revisions (record_id, version, snapshot, change_note, changed_by)
  values (p_record, n.version, private.org_record_snapshot(n), btrim(p_change_note), v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'record_updated', 'org_record', p_record::text, jsonb_build_object('version', n.version, 'fields', to_jsonb(v_changed)));
  return n.version;
end;
$function$;

create or replace function public.admin_archive_record(p_record uuid, p_reason text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  o public.org_records%rowtype;
  n public.org_records%rowtype;
begin
  select * into o from public.org_records where id = p_record for update;
  if not found then raise exception 'That record does not exist.'; end if;
  if o.archived_at is not null then raise exception 'It is already archived.'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it is being archived.'; end if;
  update public.org_records set archived_at = now(), archived_by = v_actor, archive_reason = btrim(p_reason),
    version = o.version + 1, updated_at = now() where id = p_record returning * into n;
  insert into public.org_record_revisions (record_id, version, snapshot, change_note, changed_by)
  values (p_record, n.version, private.org_record_snapshot(n), 'Archived: ' || btrim(p_reason), v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'record_archived', 'org_record', p_record::text, jsonb_build_object('reason', btrim(p_reason)));
end;
$function$;

create or replace function public.admin_restore_record(p_record uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  o public.org_records%rowtype;
  n public.org_records%rowtype;
begin
  select * into o from public.org_records where id = p_record for update;
  if not found then raise exception 'That record does not exist.'; end if;
  if o.archived_at is null then raise exception 'It is not archived.'; end if;
  update public.org_records set archived_at = null, archived_by = null, archive_reason = null,
    version = o.version + 1, updated_at = now() where id = p_record returning * into n;
  insert into public.org_record_revisions (record_id, version, snapshot, change_note, changed_by)
  values (p_record, n.version, private.org_record_snapshot(n), 'Restored', v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'record_restored', 'org_record', p_record::text, '{}'::jsonb);
end;
$function$;

-- Permanent erasure, the deliberate second step after archiving. The record must
-- be archived, past its retention date if one was set, and the title typed back.
-- The database rows go; the audit entry stays (title, category and reason only).
-- The function returns the file paths; the caller then removes those files, which
-- the storage policy allows once no record points at them.
create or replace function public.admin_erase_record(p_record uuid, p_confirm_title text, p_reason text)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  o public.org_records%rowtype;
  v_paths text[];
begin
  select * into o from public.org_records where id = p_record for update;
  if not found then raise exception 'That record does not exist.'; end if;
  if o.archived_at is null then raise exception 'Archive the record first. Erasing is a separate step.'; end if;
  if o.retain_until is not null and o.retain_until > current_date then
    raise exception 'This record is marked to be kept until %.', to_char(o.retain_until, 'FMMonth FMDD, YYYY');
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it is being erased.'; end if;
  if btrim(coalesce(p_confirm_title, '')) <> o.title then raise exception 'Type the record''s title exactly to confirm.'; end if;

  select coalesce(array_agg(storage_path order by version_no), '{}') into v_paths from public.org_record_files where record_id = p_record;
  perform set_config('records.erasing', 'on', true);
  delete from public.org_record_files where record_id = p_record;
  delete from public.org_record_revisions where record_id = p_record;
  delete from public.org_records where id = p_record;
  perform set_config('records.erasing', 'off', true);
  -- Storage can only delete what the caller can also read, so the erasing administrator gets
  -- ten minutes on exactly these paths to clear the files away (the erase is logged below).
  delete from public.org_record_file_grants where storage_path = any (v_paths);
  insert into public.org_record_file_grants (storage_path, admin_id, expires_at)
  select p, v_actor, now() + interval '10 minutes' from unnest(v_paths) as p;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'record_erased', 'org_record', p_record::text,
          jsonb_build_object('title', o.title, 'category', o.category, 'files', cardinality(v_paths), 'reason', btrim(p_reason)));
  return jsonb_build_object('storage_paths', to_jsonb(v_paths));
end;
$function$;

-- --- files: add a version, open one ---------------------------------------------------------
-- The browser uploads to records/<record id>/<file id>.<ext> first, then registers
-- it here. Size and type come from what storage actually holds, not from the caller.
create or replace function public.admin_add_record_file(p_record uuid, p_file_id uuid, p_path text, p_file_name text, p_sha256 text, p_change_note text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  o public.org_records%rowtype;
  v_meta jsonb;
  v_type text;
  v_size bigint;
  v_next integer;
begin
  select * into o from public.org_records where id = p_record for update;
  if not found then raise exception 'That record does not exist.'; end if;
  if o.archived_at is not null then raise exception 'Restore an archived record before adding a file.'; end if;
  if p_path is null or p_path !~ ('^records/' || p_record::text || '/' || p_file_id::text || '\.(pdf|jpg|jpeg|png|webp)$') then
    raise exception 'That file is not in the right place.' using errcode = '23514';
  end if;
  select metadata into v_meta from storage.objects where bucket_id = 'family-village-private' and name = p_path;
  if not found then raise exception 'Upload the file first.'; end if;
  v_type := v_meta ->> 'mimetype';
  v_size := (v_meta ->> 'size')::bigint;
  if v_type is null or v_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Only a PDF or a photo (JPG, PNG, WebP) can be kept here.';
  end if;
  select coalesce(max(version_no), 0) + 1 into v_next from public.org_record_files where record_id = p_record;
  if v_next > 1 and coalesce(btrim(p_change_note), '') = '' then raise exception 'Say what changed in this version.'; end if;
  insert into public.org_record_files (id, record_id, version_no, storage_path, file_name, content_type, size_bytes, sha256, change_note, uploaded_by)
  values (p_file_id, p_record, v_next, p_path, left(btrim(p_file_name), 200), v_type, v_size, lower(nullif(btrim(coalesce(p_sha256, '')), '')),
          nullif(left(btrim(coalesce(p_change_note, '')), 500), ''), v_actor);
  update public.org_records set updated_at = now() where id = p_record;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, case when v_next > 1 then 'record_file_replaced' else 'record_file_added' end, 'org_record', p_record::text,
          jsonb_build_object('file_id', p_file_id, 'version_no', v_next, 'content_type', v_type, 'size_bytes', v_size, 'sensitive', o.sensitive));
  return v_next;
end;
$function$;

-- The only way to read a file: asks for it, which writes the audit entry and
-- makes a two-minute grant the storage policy then honors. Returns the path.
create or replace function public.admin_open_record_file(p_file uuid, p_purpose text default 'view')
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  f public.org_record_files%rowtype;
  v_sensitive boolean;
begin
  if p_purpose is null or p_purpose not in ('view', 'download') then raise exception 'Say whether the file is being viewed or downloaded.'; end if;
  select * into f from public.org_record_files where id = p_file;
  if not found then raise exception 'That file does not exist.'; end if;
  select sensitive into v_sensitive from public.org_records where id = f.record_id;
  delete from public.org_record_file_grants where expires_at < now() - interval '1 hour';
  insert into public.org_record_file_grants (storage_path, admin_id, expires_at) values (f.storage_path, v_actor, now() + interval '2 minutes');
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, case p_purpose when 'download' then 'record_file_downloaded' else 'record_file_viewed' end, 'org_record', f.record_id::text,
          jsonb_build_object('file_id', f.id, 'version_no', f.version_no, 'sensitive', v_sensitive));
  return f.storage_path;
end;
$function$;

-- --- key facts ------------------------------------------------------------------------------
-- Sensitive values come back masked (last four characters); admin_reveal_org_fact
-- returns the real one and writes an audit entry.
create or replace function public.admin_list_org_facts()
returns table (key text, label text, value text, sensitive boolean, has_value boolean, version integer, updated_at timestamptz, updated_by_name text)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_records_admin();
  return query
  select f.key, f.label, case when f.sensitive then private.mask_fact(f.value) else f.value end, f.sensitive,
         f.value is not null and f.value <> '', f.version, f.updated_at, p.display_name
  from public.org_facts f left join public.profiles p on p.id = f.updated_by
  order by f.sort_order, f.label;
end;
$function$;

create or replace function public.admin_reveal_org_fact(p_key text)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  f public.org_facts%rowtype;
begin
  select * into f from public.org_facts where key = p_key;
  if not found then raise exception 'That fact does not exist.'; end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'org_fact_revealed', 'org_fact', p_key, jsonb_build_object('sensitive', f.sensitive));
  return f.value;
end;
$function$;

create or replace function public.admin_set_org_fact(p_key text, p_value text, p_change_note text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  f public.org_facts%rowtype;
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_version integer;
begin
  select * into f from public.org_facts where key = p_key for update;
  if not found then raise exception 'That fact does not exist.'; end if;
  if v_value is not distinct from f.value then raise exception 'Nothing changed.'; end if;
  if f.version > 0 and coalesce(btrim(p_change_note), '') = '' then raise exception 'Say why you are changing it.'; end if;
  if p_key = 'ein' and v_value is not null then
    if v_value !~ '^[0-9]{2}-?[0-9]{7}$' then raise exception 'An EIN looks like 12-3456789.'; end if;
    v_value := substr(replace(v_value, '-', ''), 1, 2) || '-' || substr(replace(v_value, '-', ''), 3);
  end if;
  v_version := f.version + 1;
  update public.org_facts set value = v_value, version = v_version, updated_by = v_actor, updated_at = now() where key = p_key;
  insert into public.org_fact_revisions (fact_key, version, value, change_note, changed_by)
  values (p_key, v_version, v_value, nullif(btrim(coalesce(p_change_note, '')), ''), v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'org_fact_updated', 'org_fact', p_key, jsonb_build_object('version', v_version, 'sensitive', f.sensitive));
  return v_version;
end;
$function$;

create or replace function public.admin_org_fact_history(p_key text)
returns table (version integer, value text, change_note text, changed_by_name text, created_at timestamptz)
language plpgsql stable security definer set search_path to ''
as $function$
declare v_sensitive boolean;
begin
  perform private.require_records_admin();
  select sensitive into v_sensitive from public.org_facts where key = p_key;
  if not found then raise exception 'That fact does not exist.'; end if;
  return query
  select r.version, case when v_sensitive then private.mask_fact(r.value) else r.value end, r.change_note, p.display_name, r.created_at
  from public.org_fact_revisions r left join public.profiles p on p.id = r.changed_by
  where r.fact_key = p_key order by r.version desc;
end;
$function$;

create or replace function public.admin_add_org_fact(p_label text, p_sensitive boolean default false)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_key text;
begin
  if coalesce(btrim(p_label), '') = '' then raise exception 'Give the fact a name.'; end if;
  v_key := 'custom_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.org_facts (key, label, sensitive, sort_order) values (v_key, btrim(p_label), coalesce(p_sensitive, false), 200);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'org_fact_added', 'org_fact', v_key, jsonb_build_object('sensitive', coalesce(p_sensitive, false)));
  return v_key;
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'admin_create_record(text,text,text,text,date,date,bigint,text,text[],boolean,date)',
    'admin_update_record(uuid,text,text,text,text,date,date,bigint,text,text[],boolean,date,text)',
    'admin_archive_record(uuid,text)', 'admin_restore_record(uuid)', 'admin_erase_record(uuid,text,text)',
    'admin_add_record_file(uuid,uuid,text,text,text,text)', 'admin_open_record_file(uuid,text)',
    'admin_list_org_facts()', 'admin_reveal_org_fact(text)', 'admin_set_org_fact(text,text,text)',
    'admin_org_fact_history(text)', 'admin_add_org_fact(text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
