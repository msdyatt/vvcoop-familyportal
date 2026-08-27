-- service_role had no SELECT/INSERT/UPDATE on any table in public -- not just
-- profiles/user_roles, every one of the 27 tables in the schema.
--
-- Root cause, found via information_schema.role_table_grants and pg_default_acl:
-- every table here was created by a migration, which runs as the `postgres`
-- role. This project's default-privilege entry for objects owned by `postgres`
-- only grants anon/authenticated/service_role `Dxtm` (delete, truncate,
-- references, maintain) -- not select/insert/update. Tables owned by
-- `supabase_admin` (Supabase's own tooling) get full CRUD for all three roles
-- automatically; tables owned by `postgres` (every table in this app) do not.
--
-- The existing "Two table-level traps" note in HANDOFF.md already covers half
-- of this -- granting `authenticated` on a new table -- because that gap shows
-- up immediately in the browser. The service_role half never did: nothing in
-- the browser ever exercises service_role, so a function that uses the
-- service-role client to deliberately bypass RLS (the documented pattern for
-- every admin-gated edge function, and the *only* reason service_role is used
-- at all) failed with a genuine Postgres "permission denied for table x" on
-- every admin action routed that way, on every table, since whichever
-- migration first created each one.
--
-- Fixed two ways: existing tables get the grant retroactively, and the default
-- privilege itself is corrected so a table created by a future migration gets
-- service_role access without anyone having to remember it. Doing the same for
-- `authenticated` is deliberately NOT included here -- unlike service_role
-- (which always bypasses RLS by design and is never reachable from a browser),
-- auto-granting authenticated by default would make a brand-new table broadly
-- readable before its RLS policies exist. That grant should stay a conscious
-- step taken alongside writing the policies, not something that happens
-- silently before they're in place.
grant select, insert, update, delete on all tables in schema public to service_role;

alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
