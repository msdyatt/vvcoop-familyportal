import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://jtwemgyhxylbhjzxgyvh.supabase.co";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_ev8c0iwH-f2Q2lO5WkSAQw_EaDc52Vd";

export function isSupabaseConfigured() {
  return Boolean(projectUrl && publishableKey);
}

export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(
      projectUrl,
      publishableKey,
      { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
    );
  }
  return client;
}
