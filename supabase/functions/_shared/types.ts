import type { SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";

/**
 * The service-role client every function builds. This project has no generated
 * database types, so the client is schema-less (`any`); naming that once here
 * keeps the suppression in one place instead of one per file.
 */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdminClient = SupabaseClient<any, "public", any>;
