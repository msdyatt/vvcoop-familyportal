alter table public.events
  add column all_day boolean not null default true;

comment on column public.events.all_day is
  'True for a plain-date event (no specific meeting time) -- the common case for co-op-wide events. starts_at/ends_at still store a timestamptz, pinned to UTC midnight when all_day is true, matching the date-only rendering convention used elsewhere.';
