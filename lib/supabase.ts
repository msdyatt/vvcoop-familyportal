import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://jtwemgyhxylbhjzxgyvh.supabase.co";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_ev8c0iwH-f2Q2lO5WkSAQw_EaDc52Vd";

export function isSupabaseConfigured() {
  return Boolean(projectUrl && publishableKey);
}

/** Public HTTPS URL for a deployed edge function -- e.g. the calendar feed, which a calendar app polls directly rather than through the supabase-js client. */
export function edgeFunctionUrl(name: string) {
  return `${projectUrl}/functions/v1/${name}`;
}

export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(
      projectUrl,
      publishableKey,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, experimental: { passkey: true } } },
    );
  }
  return client;
}
