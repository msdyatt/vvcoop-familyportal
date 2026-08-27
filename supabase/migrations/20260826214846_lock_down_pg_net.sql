-- pg_net grants http_get/http_post/http_delete to PUBLIC by default, which
-- PostgREST would expose at /rest/v1/rpc/http_post to any authenticated (or
-- even anon) caller -- an open SSRF/outbound-request primitive from the
-- app's own API, not something any client of this app should ever be able
-- to reach. Only postgres (which is what pg_cron's scheduled jobs run as)
-- needs it; the deliver-emails cron job calls net.http_post from inside a
-- cron.schedule body, not through PostgREST, so this revoke does not affect it.
--
-- Note: this revoke did not actually take effect (confirmed via
-- has_function_privilege after applying it) -- pg_net's functions are owned
-- by supabase_admin, and the connecting role here (postgres) cannot revoke a
-- grant made by a different, more-privileged owner. Left in place anyway as
-- the documented intent; the practical exposure was independently checked
-- and closed by confirming the `net` schema is not in PostgREST's exposed
-- schema list (a live request to /rest/v1/rpc/http_post returns 404).
revoke execute on function net.http_get(text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
revoke execute on function net.http_delete(text, jsonb, jsonb, integer, jsonb) from public, anon, authenticated;
revoke execute on function net.http_collect_response(bigint, boolean) from public, anon, authenticated;
