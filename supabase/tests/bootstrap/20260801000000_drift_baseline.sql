-- Objects that exist in production but were created by hand and never appeared
-- in a migration (see the "prior drift" notes in migrations 20260821031741,
-- 20260822070353 and 20260822212739), so replaying the migration history into
-- an empty database cannot reproduce them.
--
-- CI's database-tests job copies this file in as the FIRST migration of a
-- throwaway local database. It is never applied to production, and it is not
-- a migration here: production already has all of this. Foreign keys to
-- tables that do not exist yet are left out on purpose; the real migrations
-- add what they need on top.
--
-- As the history is made replayable, entries come out of here.

create table if not exists public.integration_settings (
  id text primary key,
  display_name text not null,
  status text not null default 'not_configured'
    check (status in ('not_configured', 'pending', 'connected', 'attention')),
  public_note text,
  external_url text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.integration_settings enable row level security;

create table if not exists public.enrollment_periods (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (closes_at > opens_at)
);
alter table public.enrollment_periods enable row level security;

create table if not exists public.enrollment_requests (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null,
  class_id uuid not null,
  child_id uuid not null,
  requested_by uuid not null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'waitlisted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, class_id, child_id)
);
alter table public.enrollment_requests enable row level security;
