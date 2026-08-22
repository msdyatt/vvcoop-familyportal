-- Family compliance: required documents and dues, tracked per family per year
-- ---------------------------------------------------------------------------
-- Until now a `documents` row belonged to exactly one family, so there was no
-- way to say "every family must sign the handbook" short of uploading it once
-- per household, and nothing could answer "who hasn't signed". Dues did not
-- exist at all.
--
-- Three tables:
--   school_years        the scoping spine; a handbook signed for 2026-27 does
--                       not carry into 2027-28
--   requirements        what every family owes in a given year, either a
--                       document to sign or a dues amount to pay
--   family_requirements the per-family status -- the compliance matrix
--
-- Dues are tracked, not collected. The co-op banks with Crowded, whose API is a
-- partner programme for software platforms rather than something an account
-- holder can connect to, so the portal stores Crowded's payment link and an
-- administrator records receipt.
-- ---------------------------------------------------------------------------

-- --- school years ----------------------------------------------------------
create table if not exists public.school_years (
  id uuid primary key default gen_random_uuid(),
  label text not null unique,          -- '2026-27'
  starts_on date,
  ends_on date,
  is_current boolean not null default false,
  created_at timestamptz not null default now()
);

-- Exactly one current year, enforced rather than remembered.
create unique index if not exists school_years_single_current_idx
  on public.school_years(is_current) where is_current;

-- --- requirements ----------------------------------------------------------
create table if not exists public.requirements (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references public.school_years(id) on delete cascade,
  kind text not null check (kind in ('document', 'dues')),
  title text not null,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,

  -- kind = 'document'
  document_id uuid references public.documents(id) on delete set null,

  -- kind = 'dues'
  amount_per_family numeric(10,2),
  amount_per_child numeric(10,2),
  payment_url text,                    -- the Crowded payment link
  due_on date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Each kind must carry the columns it actually needs.
  constraint requirements_kind_shape check (
    (kind = 'document' and amount_per_family is null and amount_per_child is null)
    or
    (kind = 'dues' and (amount_per_family is not null or amount_per_child is not null))
  )
);

create index if not exists requirements_school_year_idx on public.requirements(school_year_id);

-- --- per-family status -----------------------------------------------------
create table if not exists public.family_requirements (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements(id) on delete cascade,
  family_id uuid not null references public.families(id) on delete cascade,
  status text not null default 'outstanding'
    check (status in ('outstanding', 'sent', 'complete', 'waived')),

  -- documents
  signed_document_id uuid references public.documents(id) on delete set null,
  signed_by_user_id uuid references public.profiles(id),
  signed_at timestamptz,
  provider_document_id text,
  signing_url text,

  -- dues. amount_due is captured when the requirement is opened rather than
  -- derived on read, so adding a child mid-year cannot silently change what a
  -- family was told they owe. Administrators recalculate explicitly.
  amount_due numeric(10,2),
  amount_paid numeric(10,2) not null default 0,
  paid_at timestamptz,
  payment_method text,
  payment_reference text,

  note text,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (requirement_id, family_id)
);

create index if not exists family_requirements_family_idx on public.family_requirements(family_id);
create index if not exists family_requirements_requirement_idx on public.family_requirements(requirement_id);
create index if not exists family_requirements_provider_doc_idx
  on public.family_requirements(provider_document_id) where provider_document_id is not null;

-- --- row level security ----------------------------------------------------
alter table public.school_years enable row level security;
alter table public.requirements enable row level security;
alter table public.family_requirements enable row level security;

-- Years and requirements are shared reference data: any active member may read
-- them, only administrators may change them.
drop policy if exists school_years_read on public.school_years;
create policy school_years_read on public.school_years
  for select to authenticated using (private.is_active_user());

drop policy if exists school_years_admin_write on public.school_years;
create policy school_years_admin_write on public.school_years
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

drop policy if exists requirements_read on public.requirements;
create policy requirements_read on public.requirements
  for select to authenticated using (private.is_active_user());

drop policy if exists requirements_admin_write on public.requirements;
create policy requirements_admin_write on public.requirements
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

-- A family sees its own standing and nothing else. Administrators see and
-- change everything -- recording a payment or waiving an item is theirs alone,
-- so a family cannot mark itself complete.
drop policy if exists family_requirements_family_read on public.family_requirements;
create policy family_requirements_family_read on public.family_requirements
  for select to authenticated
  using (private.has_family_access(family_id));

drop policy if exists family_requirements_admin_read on public.family_requirements;
create policy family_requirements_admin_read on public.family_requirements
  for select to authenticated using (private.has_role('admin'));

drop policy if exists family_requirements_admin_write on public.family_requirements;
create policy family_requirements_admin_write on public.family_requirements
  for all to authenticated
  using (private.has_role('admin')) with check (private.has_role('admin'));

grant select on public.school_years, public.requirements, public.family_requirements to authenticated;
grant insert, update, delete on public.school_years, public.requirements, public.family_requirements to authenticated;

-- --- updated_at triggers ---------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists requirements_touch_updated_at on public.requirements;
create trigger requirements_touch_updated_at
  before update on public.requirements
  for each row execute function public.touch_updated_at();

drop trigger if exists family_requirements_touch_updated_at on public.family_requirements;
create trigger family_requirements_touch_updated_at
  before update on public.family_requirements
  for each row execute function public.touch_updated_at();

-- --- tidy up a policy from the previous migration --------------------------
-- signature_requests_family_read hand-rolled a documents/family_members join.
-- private.has_family_access already expresses exactly that, and using it keeps
-- family scoping defined in one place.
drop policy if exists signature_requests_family_read on public.signature_requests;
create policy signature_requests_family_read on public.signature_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = signature_requests.document_id
        and d.family_id is not null
        and private.has_family_access(d.family_id)
    )
  );
