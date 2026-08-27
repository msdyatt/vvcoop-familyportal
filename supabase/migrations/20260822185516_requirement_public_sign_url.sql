-- Public signing links on document requirements
-- ---------------------------------------------------------------------------
-- The co-op publishes each required document as an OpenSign public template and
-- shares one link with every family, rather than the portal generating a
-- per-family signing link through the API.
--
-- Trade-off, recorded so it is not rediscovered later: a public template asks
-- the signer to type their own name and email, so the returned signature is not
-- inherently tied to a household. Identity therefore cannot be trusted from the
-- webhook alone the way it can with an API send, and an administrator confirms
-- completion in the Compliance tab. The upside is that no per-family send is
-- needed and no signature allowance is consumed per household.
--
-- requirements.document_id stays: it is still how a stored PDF is attached for
-- an API send, which remains available per family for anything that needs a
-- verifiable signer.
-- ---------------------------------------------------------------------------

alter table public.requirements
  add column if not exists public_sign_url text;

comment on column public.requirements.public_sign_url is
  'OpenSign public template link, shared by every family. When set, the family portal shows a Sign now button pointing here instead of waiting for a per-family API link.';
