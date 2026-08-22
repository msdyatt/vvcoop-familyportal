-- OpenSign signature requests
-- ---------------------------------------------------------------------------
-- public.documents already carries signature_provider, provider_document_id and
-- signature_status from the foundation migration, but nothing has ever written
-- to them. Sending a document for signature needs two things they do not cover:
--
--   1. A fast lookup by provider_document_id. The webhook only knows OpenSign's
--      own id, and without an index every callback is a sequential scan.
--   2. A record of who was asked to sign, when, and what came back. A single
--      status column on documents cannot answer "who has signed and who has
--      not" for a waiver sent to two guardians, and a co-op needs that answer.
--
-- Note on prior drift: public.integration_settings was created by hand and has
-- never appeared in a migration, so a fresh `supabase db reset` would not
-- reproduce it. That is recorded here as a known gap rather than silently
-- fixed, because writing a create-table for a table that already exists in
-- production risks diverging from whatever the live definition actually is.
-- ---------------------------------------------------------------------------

create index if not exists documents_provider_document_id_idx
  on public.documents(provider_document_id)
  where provider_document_id is not null;

create table if not exists public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  provider text not null default 'opensign',
  provider_document_id text,
  signer_email text not null,
  signer_name text,
  -- pending -> sent -> viewed -> signed | declined | expired | failed
  status text not null default 'pending',
  signing_url text,
  error_detail text,
  requested_by_user_id uuid references public.profiles(id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists signature_requests_document_id_idx
  on public.signature_requests(document_id);
create index if not exists signature_requests_provider_document_id_idx
  on public.signature_requests(provider_document_id);

alter table public.signature_requests enable row level security;

-- Admins manage signature requests. Previously no client could see signature
-- state at all beyond the single status column on documents; this lets the
-- Admin workspace list who was asked to sign and where each request stands.
create policy signature_requests_admin_read on public.signature_requests
  for select to authenticated
  using (private.has_role('admin'));

create policy signature_requests_admin_write on public.signature_requests
  for all to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

-- Families may read the requests raised against their own household's
-- documents, so a parent can see that a waiver is outstanding. They cannot
-- create or alter one -- that stays with administrators and the edge function.
create policy signature_requests_family_read on public.signature_requests
  for select to authenticated
  using (
    exists (
      select 1
      from public.documents d
      join public.family_members fm on fm.family_id = d.family_id
      where d.id = signature_requests.document_id
        and fm.user_id = auth.uid()
    )
  );

grant select on public.signature_requests to authenticated;
grant insert, update, delete on public.signature_requests to authenticated;

create or replace function public.touch_signature_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists signature_requests_touch_updated_at on public.signature_requests;
create trigger signature_requests_touch_updated_at
  before update on public.signature_requests
  for each row execute function public.touch_signature_requests_updated_at();
