-- Retire OpenSign.
--
-- Signing now happens inside the portal (sign_* tables and functions), so what
-- existed only for OpenSign goes. Production was read before writing this
-- (6 Nov 2026), so nothing here is a guess:
--
--   signature_requests    1 row: a request "sent" to OpenSign on 2026-08-23
--                         04:31 UTC, never marked signed itself. The signature
--                         it produced lives on family_requirements (below), so
--                         the table adds nothing.
--   requirements          2 rows with an OpenSign public link and template id:
--                           Family handbook   template NOWgrVuBcr
--                           Liability waiver  template EmfQUgwGOC
--                         Both are recorded here so they are not lost, and both
--                         are dead the moment the OpenSign account closes.
--   family_requirements   1 row with an OpenSign link (the Family handbook,
--                         complete, signed 2026-08-23 04:43 UTC, with a signed
--                         copy in the private bucket and a certificate_url).
--   integration_settings  the 'opensign' row (status "connected").
--
-- Kept on purpose, because that completed handbook still points at them:
--   family_requirements.provider_document_id, certificate_url, signed_document_id
--   documents.signature_provider, provider_document_id, signature_status
--   requirements.document_id (a stored PDF attached to a requirement)
-- Drop those later only after deciding what to do with that one record.

delete from public.integration_settings where id = 'opensign';

drop table if exists public.signature_requests;
drop function if exists public.touch_signature_requests_updated_at();

alter table public.requirements
  drop column if exists public_sign_url,
  drop column if exists opensign_template_id;

alter table public.family_requirements
  drop column if exists signing_url,
  drop column if exists last_synced_at;

comment on column public.family_requirements.provider_document_id is
  'History: the id of the document at the retired OpenSign service. Nothing reads it any more.';
comment on column public.family_requirements.certificate_url is
  'History: a certificate link from the retired OpenSign service. Signatures made in the portal keep their certificate inside the sealed PDF instead.';
