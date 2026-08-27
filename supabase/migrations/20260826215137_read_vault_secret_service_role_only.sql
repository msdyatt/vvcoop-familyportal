-- A narrow bridge for the deliver-emails edge function to read a Vault secret
-- through its service-role PostgREST client. vault.decrypted_secrets is never
-- itself exposed via PostgREST (correctly so -- that would leak every secret
-- to anyone who could reach the REST API), so this function is the one
-- deliberately narrow crack: SECURITY DEFINER to read the vault, but EXECUTE
-- granted only to service_role, which only server-side code (this project's
-- own edge functions) ever authenticates as. No app user, admin included,
-- can reach this through the browser.
create or replace function public.read_vault_secret(secret_name text)
returns text
language sql security definer set search_path to ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = secret_name;
$$;

revoke all on function public.read_vault_secret(text) from public, anon, authenticated;
grant execute on function public.read_vault_secret(text) to service_role;
