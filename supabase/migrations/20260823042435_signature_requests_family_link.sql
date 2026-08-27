-- signature_requests.document_id was NOT NULL, but the primary send path is
-- now per-family, from a template -- opensign-send only sets document_id on
-- the standalone-document path, never on a family_requirement send. Every
-- template send (the one HANDOFF describes as the actual supported path)
-- failed this constraint before ever reaching OpenSign.
--
-- Adding family_requirement_id rather than only loosening the NOT NULL: the
-- table exists so "a failure is still visible ... rather than vanishing" (its
-- own comment in opensign-send). A row with neither id set would satisfy that
-- promise in name only -- there would be nothing to trace it back to.
alter table public.signature_requests
  add column family_requirement_id uuid references public.family_requirements(id) on delete cascade,
  alter column document_id drop not null;

alter table public.signature_requests
  add constraint signature_requests_target_check
  check (document_id is not null or family_requirement_id is not null);

create index if not exists signature_requests_family_requirement_idx
  on public.signature_requests (family_requirement_id);
