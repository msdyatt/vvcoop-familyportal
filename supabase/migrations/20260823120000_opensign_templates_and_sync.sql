-- Track signatures properly
-- ---------------------------------------------------------------------------
-- Public template links cannot be tracked: the signer types their own email, so
-- a completed signature has nothing tying it to a household. Required documents
-- move to per-family sends, which do.
--
-- They are sent from the OpenSign templates the co-op already built, via
-- POST /createdocument/:template_id, rather than re-uploading a PDF. That keeps
-- the signature fields where they were placed by hand -- the alternative put a
-- signature box on page 1 of a ten-page handbook.
--
-- Tracking no longer depends on the webhook. GET /document/:id returns the
-- status, the signed file and a completion certificate, so a sync can poll for
-- outcomes. The webhook remains the instant path once its secret is set; the
-- poll is the one that works today and the safety net if a callback is missed.
-- ---------------------------------------------------------------------------

alter table public.requirements
  add column if not exists opensign_template_id text;

comment on column public.requirements.opensign_template_id is
  'OpenSign template to send per family. Preferred over document_id: the template carries the signature field positions.';

-- The template id is already sitting in the public link, so lift it rather than
-- asking anyone to re-enter it.
update public.requirements
set opensign_template_id = substring(public_sign_url from 'templateid=([A-Za-z0-9_-]+)')
where opensign_template_id is null
  and public_sign_url like '%templateid=%';

-- Where the signed copy and certificate land once a document completes.
alter table public.family_requirements
  add column if not exists certificate_url text,
  add column if not exists last_synced_at timestamptz;

comment on column public.family_requirements.last_synced_at is
  'When the signature status was last checked against OpenSign.';
