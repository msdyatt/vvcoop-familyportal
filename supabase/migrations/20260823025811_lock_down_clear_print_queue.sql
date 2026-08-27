-- clear_print_queue() is SECURITY DEFINER and had no ACL, which in Postgres
-- means EXECUTE to PUBLIC. PostgREST exposes every public function as an RPC
-- endpoint, so /rest/v1/rpc/clear_print_queue would wipe every pending print
-- job for anyone who sent it an anonymous POST. The Supabase API is not behind
-- the site's Cloudflare password gate, so that was directly reachable.
--
-- Only the weekly pg_cron job needs it, and that job runs as postgres, which
-- owns the function and keeps EXECUTE regardless.
revoke execute on function public.clear_print_queue() from public;
revoke execute on function public.clear_print_queue() from anon;
revoke execute on function public.clear_print_queue() from authenticated;
