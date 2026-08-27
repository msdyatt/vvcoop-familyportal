-- A queue for sending a printable report to the co-op's physical office
-- printer (a Brother HL-L3300CDW) instead of -- or in addition to -- the
-- browser's own print dialog. Named print_jobs, not print_requests, because
-- that name is already taken by the unrelated teacher-handout-copies queue
-- (see storage_access_for_handouts_and_print_requests.sql) -- a teacher
-- asking the office to run off copies of a worksheet is a different feature
-- from a report going straight to a printer.
--
-- Nothing consumes this queue yet: the plan is a small script on a Raspberry
-- Pi wired to the printer, which will poll the print-queue edge function
-- below and submit each job over IPP/CUPS. This migration only builds the
-- request side -- the shape a job needs to carry so that script has
-- everything it needs once it exists.
--
-- Admin-only, same as the Reports and Classes tabs this feeds: no
-- family-facing policy is needed.
create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid references public.profiles(id) on delete set null,
  title text not null,
  -- A fully self-contained HTML document (the report's markup with its
  -- colors, fonts, and table rules inlined) rather than a bare snapshot of
  -- the live page -- whatever eventually renders this into a PDF for the
  -- printer will not be running inside this app's own React tree or have
  -- its stylesheet loaded, so the row has to stand on its own.
  html_body text not null,
  duplex boolean not null default true,
  -- Both sides of the same fact: `duplex`/`orientation` are what the admin
  -- UI shows and edits, `sides` is the literal IPP `sides` attribute value
  -- (one-sided / two-sided-long-edge / two-sided-short-edge) already worked
  -- out from those two -- landscape duplex has to bind on the short edge to
  -- keep the second side right-side-up when flipped, unlike portrait -- so
  -- the future printing script can hand it straight to the printer instead
  -- of re-deriving printer semantics from scratch.
  orientation text not null default 'landscape' check (orientation in ('portrait', 'landscape')),
  sides text not null default 'two-sided-short-edge' check (sides in ('one-sided', 'two-sided-long-edge', 'two-sided-short-edge')),
  copies smallint not null default 1 check (copies between 1 and 20),
  -- Not a foreign key to a printer-registry table -- there is exactly one
  -- physical printer this feeds today. A free-text default keeps the door
  -- open if a second one ever shows up without a migration to add it.
  printer_id text not null default 'office',
  status text not null default 'pending' check (status in ('pending', 'sending', 'printed', 'failed', 'canceled')),
  error_detail text,
  created_at timestamptz not null default now(),
  printed_at timestamptz
);

create index print_jobs_status_idx on public.print_jobs(status, created_at);

alter table public.print_jobs enable row level security;

create policy print_jobs_admin_all on public.print_jobs
  for all to authenticated using (private.has_role('admin')) with check (private.has_role('admin'));

grant select, insert, update on public.print_jobs to authenticated;
-- No delete grant: a job an admin no longer wants gets its status set to
-- 'canceled' instead, so the queue keeps a real record of what was sent.

-- Seed the printer's own row in integration_settings, matching the pattern
-- already used for OpenSign/Resend/Facebook -- the Integrations tab can show
-- and edit it without a dedicated table just for one printer's status.
insert into public.integration_settings (id, display_name, status, public_note)
values ('printer', 'Office printer (Brother HL-L3300CDW)', 'not_configured', 'Set the printer''s IP or hostname below once the Raspberry Pi is set up. The queue endpoint and shared secret it needs live in Supabase Vault, not this table.')
on conflict (id) do nothing;
