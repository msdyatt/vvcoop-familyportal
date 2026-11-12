/**
 * Calendar subscription links.
 *
 * These point at the co-op's own domain (the Worker's /calendar/feed route,
 * see worker/calendar-feed.ts), never at the Supabase edge function directly.
 * A calendar app remembers the address it subscribed to for good, so that
 * address has to be one the co-op controls and can keep serving if the backend
 * ever moves. This file deliberately imports nothing so it stays trivially
 * testable (lib/calendar-links.test.ts).
 */

/** The production portal domain. Also what the iPhone app loads its pages from, so links built in the app use it too. */
export const DEFAULT_SITE_URL = "https://family.veritasvillage.org";

/** The path the Worker answers for calendar feeds. Keep in step with worker/calendar-feed.ts. */
export const CALENDAR_FEED_PATH = "/calendar/feed";

/**
 * Turns a configured site URL into a bare origin, or the default when it is
 * missing or unusable. Only https (or http on localhost, for local work) is
 * accepted, and any path, query or trailing slash is dropped.
 */
export function normalizeSiteUrl(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_SITE_URL;
  try {
    const url = new URL(trimmed);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return DEFAULT_SITE_URL;
    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

/**
 * Fixed when the app is built (NEXT_PUBLIC_SITE_URL), never read from
 * window.location: previews and the native app load pages from other hosts,
 * and a feed link must still name the real co-op domain.
 */
export const SITE_URL = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);

/** The plain https URL for a calendar-feed scope -- what to paste into Google Calendar's "Other calendars → From URL" field. */
export function calendarFeedUrl(query: string, siteUrl: string = SITE_URL) {
  return `${siteUrl}${CALENDAR_FEED_PATH}?${query}`;
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
export function calendarSubscribeUrl(query: string, siteUrl: string = SITE_URL) {
  return calendarFeedUrl(query, siteUrl).replace(/^https?:\/\//, "webcal://");
}

/**
 * Opens Google Calendar's own "Add by URL" flow with the feed pre-filled,
 * so subscribing there is one click too instead of a copy-paste into
 * Settings -> Add calendar -> From URL.
 */
export function googleCalendarAddUrl(query: string, siteUrl: string = SITE_URL) {
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(calendarFeedUrl(query, siteUrl))}`;
}
