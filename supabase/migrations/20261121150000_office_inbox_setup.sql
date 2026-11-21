-- Office inbox setup from Admin, Integrations (issue #112).
-- ---------------------------------------------------------------------------
-- The four values the office-inbox Edge Functions need can now be entered on the Office inbox card
-- instead of being set as Edge Function secrets (those still work and are used for anything left
-- blank here):
--
--   Google OAuth client ID    office_inbox_settings.google_client_id         (not secret)
--   Google OAuth client secret Vault, OFFICE_INBOX_GOOGLE_CLIENT_SECRET       (write-only from the browser)
--   Office mailbox address    office_inbox_settings.allowed_mailbox          (the only account that may connect)
--   Portal address            office_inbox_settings.portal_site_url          (where the browser returns)
--
-- The client secret is never returned to a browser: office_inbox_setup() only says whether one is
-- saved. Only the Edge Functions (service role) read it, through office_inbox_google_config().
-- Saving writes an inbox_events row and an audit_log row naming the fields that changed, never the
-- secret itself.
-- ---------------------------------------------------------------------------

alter table public.office_inbox_settings
  add column if not exists google_client_id text
    check (google_client_id is null or google_client_id ~ '^[A-Za-z0-9._-]{10,200}$'),
  add column if not exists allowed_mailbox text
    check (allowed_mailbox is null or allowed_mailbox ~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$'),
  add column if not exists portal_site_url text
    check (portal_site_url is null or portal_site_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' or portal_site_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$');

alter table public.inbox_events drop constraint if exists inbox_events_kind_check;
alter table public.inbox_events add constraint inbox_events_kind_check
  check (kind in ('status', 'assigned', 'category', 'family_linked', 'note_added', 'reply_sent', 'reply_failed',
                  'attachment_opened', 'connected', 'disconnected', 'canned_saved', 'canned_archived', 'setup_saved'));

-- What the card shows. The secret is reported as saved or not, never shown.
create or replace function public.office_inbox_setup()
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare s public.office_inbox_settings;
begin
  perform private.require_inbox_admin();
  select * into s from public.office_inbox_settings where id = 'office';
  return jsonb_build_object(
    'google_client_id', s.google_client_id,
    'client_secret_saved', exists (select 1 from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'),
    'allowed_mailbox', s.allowed_mailbox,
    'portal_site_url', s.portal_site_url);
end;
$function$;

-- Save the setup. A null or blank secret keeps the saved one; p_clear_secret removes it.
-- The office address cannot change while a different mailbox is connected (disconnect first).
create or replace function public.office_inbox_save_setup(
  p_client_id text, p_client_secret text, p_allowed_mailbox text, p_portal_site_url text, p_clear_secret boolean default false)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_inbox_admin();
  s public.office_inbox_settings;
  v_client_id text := nullif(btrim(coalesce(p_client_id, '')), '');
  v_secret text := nullif(btrim(coalesce(p_client_secret, '')), '');
  v_mailbox text := nullif(lower(btrim(coalesce(p_allowed_mailbox, ''))), '');
  v_site text := nullif(regexp_replace(btrim(coalesce(p_portal_site_url, '')), '/+$', ''), '');
  v_secret_id uuid;
  v_changed text[] := '{}';
begin
  select * into s from public.office_inbox_settings where id = 'office' for update;
  if v_client_id is not null and v_client_id !~ '^[A-Za-z0-9._-]{10,200}$' then
    raise exception 'That does not look like a Google client ID. Copy it from Google Cloud, Credentials.';
  end if;
  if v_secret is not null and (char_length(v_secret) < 10 or char_length(v_secret) > 200 or v_secret ~ '\s') then
    raise exception 'That does not look like a Google client secret. Copy it from Google Cloud, Credentials.';
  end if;
  if v_mailbox is not null and v_mailbox !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then
    raise exception 'Enter the office mailbox as an email address, for example office@veritasvillage.org.';
  end if;
  if v_site is not null and v_site !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' and v_site !~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$' then
    raise exception 'Enter the portal address as https:// and the host name only, for example https://family.veritasvillage.org.';
  end if;
  if s.status in ('connected', 'attention') and v_mailbox is distinct from s.allowed_mailbox
     and s.mailbox_address is not null and v_mailbox is distinct from s.mailbox_address then
    raise exception 'Disconnect the office inbox before changing which mailbox it reads.';
  end if;

  if v_client_id is distinct from s.google_client_id then v_changed := array_append(v_changed, 'client_id'); end if;
  if v_mailbox is distinct from s.allowed_mailbox then v_changed := array_append(v_changed, 'mailbox'); end if;
  if v_site is distinct from s.portal_site_url then v_changed := array_append(v_changed, 'portal_site_url'); end if;
  update public.office_inbox_settings
  set google_client_id = v_client_id, allowed_mailbox = v_mailbox, portal_site_url = v_site, updated_at = now()
  where id = 'office';

  select id into v_secret_id from vault.secrets where name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET';
  if v_secret is not null then
    if v_secret_id is null then
      perform vault.create_secret(v_secret, 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET', 'Office inbox: Google OAuth client secret');
    else
      perform vault.update_secret(v_secret_id, v_secret);
    end if;
    v_changed := array_append(v_changed, 'client_secret');
  elsif coalesce(p_clear_secret, false) and v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
    v_changed := array_append(v_changed, 'client_secret_removed');
  end if;

  if cardinality(v_changed) > 0 then
    perform private.inbox_log(null, v_me, 'setup_saved', jsonb_build_object('changed', to_jsonb(v_changed)));
  end if;
end;
$function$;

-- For the Edge Functions only: the saved values, secret included.
create or replace function public.office_inbox_google_config()
returns jsonb
language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object(
    'GOOGLE_OAUTH_CLIENT_ID', s.google_client_id,
    'GOOGLE_OAUTH_CLIENT_SECRET', (select d.decrypted_secret from vault.decrypted_secrets d where d.name = 'OFFICE_INBOX_GOOGLE_CLIENT_SECRET'),
    'OFFICE_INBOX_ADDRESS', s.allowed_mailbox,
    'PORTAL_SITE_URL', s.portal_site_url)
  from public.office_inbox_settings s where s.id = 'office';
$function$;

revoke all on function public.office_inbox_setup() from public, anon;
grant execute on function public.office_inbox_setup() to authenticated;
revoke all on function public.office_inbox_save_setup(text, text, text, text, boolean) from public, anon;
grant execute on function public.office_inbox_save_setup(text, text, text, text, boolean) to authenticated;
revoke all on function public.office_inbox_google_config() from public, anon, authenticated;
grant execute on function public.office_inbox_google_config() to service_role;
