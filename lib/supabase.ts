import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://jtwemgyhxylbhjzxgyvh.supabase.co";
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_ev8c0iwH-f2Q2lO5WkSAQw_EaDc52Vd";

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
 * out for no reason" instead of "OpenSign needs your attention."
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

/**
 * Opens Google Calendar's own "Add by URL" flow with the feed pre-filled,
 * so subscribing there is one click too instead of a copy-paste into
 * Settings -> Add calendar -> From URL.
 */
export function googleCalendarAddUrl(query: string) {
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(calendarFeedUrl(query))}`;
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
