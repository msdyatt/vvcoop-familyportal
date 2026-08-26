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

/** The plain https URL for a calendar-feed scope -- what to paste into Google Calendar's "Other calendars → From URL" field. */
export function calendarFeedUrl(query: string) {
  return `${edgeFunctionUrl("calendar-feed")}?${query}`;
}

/**
 * The webcal:// form of the same feed.
 *
 * Apple Calendar, Outlook, and most phone calendar apps treat a webcal://
 * link specially -- clicking it opens a real "Subscribe" prompt that keeps
 * refreshing on its own. A plain https:// link to the same .ics resource
 * usually just downloads or opens the raw file once, which reads as broken
 * ("this only shows today's events") the moment anything on the calendar
 * changes.
 */
export function calendarSubscribeUrl(query: string) {
  return calendarFeedUrl(query).replace(/^https?:\/\//, "webcal://");
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
