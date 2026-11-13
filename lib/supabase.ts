import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://jtwemgyhxylbhjzxgyvh.supabase.co";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_ev8c0iwH-f2Q2lO5WkSAQw_EaDc52Vd";

/** Where the project is and its public (publishable) key, for the iPhone app's native screens (lib/native-session.ts). */
export function supabaseConnection() {
  return { url: projectUrl, key: publishableKey };
}

export function isSupabaseConfigured() {
  return Boolean(projectUrl && publishableKey);
}

/**
 * The real reason a `supabase.functions.invoke()` call failed.
 *
 * When an edge function returns a non-2xx response, supabase-js's `error`
 * always carries the same generic `error.message` ("Edge Function returned a
 * non-2xx status code") regardless of what the function actually said --
 * the real body only lives on `error.context` (the raw Response), which the
 * caller has to fetch and parse itself. Every call site that skipped this and
 * just read `error?.message` showed that generic sentence instead of, say,
 * "Please purchase or renew your subscription" -- which reads as "erroring
 * out for no reason" instead of "this service needs your attention."
 */
export async function functionErrorMessage(error: unknown, data: { error?: string } | null | undefined, fallback: string): Promise<string> {
  if (data?.error) return data.error;
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (typeof body?.error === "string" && body.error) return body.error;
    } catch {
      // Body wasn't JSON (or already consumed) -- fall through.
    }
  }
  return (error as { message?: string })?.message || fallback;
}

/** Public HTTPS URL for a deployed edge function the browser calls directly. Calendar subscription links are deliberately not built from this: they point at the co-op's own domain (lib/calendar-links.ts). */
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
