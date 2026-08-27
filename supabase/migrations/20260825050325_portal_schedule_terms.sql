-- A schedule slot now belongs to a weekday as well as a time. Existing slots
-- were all created for the established Friday program, so the backfill is
-- explicit rather than leaving their day unknown.
alter table public.class_blocks
  add column if not exists day_of_week smallint not null default 5,
  add constraint class_blocks_day_of_week_check
    check (day_of_week between 0 and 6);

comment on column public.class_blocks.day_of_week is
  'Postgres day number: Sunday 0 through Saturday 6.';

-- Terms are the date-bounded pieces of a school year (semester, quarter, or
-- any custom block). A class can span more than one, so the relationship is a
-- join table rather than a single classes.term_id column.
create table public.academic_terms (
  id uuid primary key default gen_random_uuid(),
  school_year_id uuid not null references public.school_years(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  starts_on date not null,
  ends_on date not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint academic_terms_date_order check (ends_on >= starts_on),
  constraint academic_terms_year_label_unique unique (school_year_id, label)
);

create index academic_terms_year_dates_idx
  on public.academic_terms (school_year_id, starts_on, ends_on);

create table public.class_terms (
  class_id uuid not null references public.classes(id) on delete cascade,
  term_id uuid not null references public.academic_terms(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (class_id, term_id)
);

create index class_terms_term_idx on public.class_terms (term_id, class_id);

alter table public.academic_terms enable row level security;
alter table public.class_terms enable row level security;

create policy academic_terms_read on public.academic_terms
  for select to authenticated
  using (private.is_active_user());

create policy academic_terms_admin on public.academic_terms
  for all to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

create policy class_terms_read on public.class_terms
  for select to authenticated
  using (private.is_active_user());

create policy class_terms_admin on public.class_terms
  for all to authenticated
  using (private.has_role('admin'))
  with check (private.has_role('admin'));

grant select, insert, update, delete on public.academic_terms to authenticated;
grant select, insert, update, delete on public.class_terms to authenticated;

-- Keep the date stamp honest when an administrator edits a term.
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger academic_terms_set_updated_at
  before update on public.academic_terms
  for each row execute function private.touch_updated_at();
