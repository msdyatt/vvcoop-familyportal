/**
 * Calendar-feed pass-through on the co-op's own domain.
 *
 * Calendar apps (Apple Calendar via webcal://, Google's "Add by URL") remember
 * the exact address they subscribed to, forever. Pointing them straight at the
 * Supabase edge function meant every family's phone remembered a supabase.co
 * address, which would break the day the backend moves. They subscribe to
 * `https://<co-op domain>/calendar/feed?...` instead, and this route fetches
 * the real feed from the edge function on their behalf. Moving the backend
 * later means changing one upstream URL here, not asking every family to
 * re-subscribe.
 *
 * The old Supabase address keeps working unchanged: the edge function is not
 * touched, so subscriptions made before this route existed are unaffected.
 *
 * This route is answered ahead of the shared-password gate (worker/index.ts),
 * for the same reason as the Apple app-site-association file: a calendar app,
 * or Google's servers fetching on its behalf, cannot sign in. What protects a
 * private feed is its unguessable `token`, which the edge function checks.
 * This route therefore treats the query string as a credential: it never logs
 * it, never echoes it, and forwards only the parameters the feed understands.
 */

export const CALENDAR_FEED_PATH = "/calendar/feed";

/**
 * Used when the Worker has no SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 * binding. The same project URL lib/supabase.ts falls back to; it is public
 * (the browser bundle ships it), so having it in source is no secret.
 */
export const DEFAULT_SUPABASE_URL = "https://jtwemgyhxylbhjzxgyvh.supabase.co";

/** The only query parameters supabase/functions/calendar-feed reads. */
const ALLOWED_PARAMS = new Set(["scope", "id", "token"]);
/** Real values are short (a scope word, two UUIDs); anything much longer is not a feed request. */
const MAX_PARAM_LENGTH = 256;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type CalendarFeedEnv = {
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

const BASE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  // A calendar address has no business being sent along as a Referer, and its
  // query string must never end up in someone else's access logs that way.
  "Referrer-Policy": "no-referrer",
};

function plain(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** The upstream edge function URL, or null if the configured project URL is not a usable https origin. */
export function upstreamFeedUrl(env: CalendarFeedEnv): URL | null {
  const configured = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:") return null;
    return new URL("/functions/v1/calendar-feed", base.origin);
  } catch {
    return null;
  }
}

/**
 * Validates the caller's query string and rebuilds it from scratch. Returns
 * null when it contains anything other than one each of scope/id/token (or
 * a value too long to be real), so nothing the caller sent that the feed does
 * not understand can ride along upstream.
 */
export function sanitizedFeedQuery(search: URLSearchParams): URLSearchParams | null {
  const clean = new URLSearchParams();
  for (const [key, value] of search) {
    if (!ALLOWED_PARAMS.has(key)) return null;
    if (clean.has(key)) return null;
    if (value.length > MAX_PARAM_LENGTH) return null;
    clean.set(key, value);
  }
  return clean;
}

export async function handleCalendarFeed(request: Request, env: CalendarFeedEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
  }

  const query = sanitizedFeedQuery(new URL(request.url).searchParams);
  if (!query) return plain(400, "Unsupported calendar feed parameters.");

  const upstream = upstreamFeedUrl(env);
  if (!upstream) return plain(500, "The calendar feed is not configured.");
  upstream.search = query.toString();

  let response: Response;
  try {
    // A fresh request built from scratch: no cookies, no Authorization, none
    // of the caller's headers. redirect:"manual" so an unexpected redirect is
    // reported rather than silently followed to somewhere else.
    response = await fetch(upstream.toString(), {
      method: "GET",
      headers: { Accept: "text/calendar, text/plain;q=0.5", "User-Agent": "veritas-village-calendar-proxy" },
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    // Only the error's name is logged. Never the URL, never the message (a
    // fetch error message can quote the URL, and the URL holds the token).
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    console.error(`calendar-feed upstream ${timedOut ? "timed out" : "failed"}`);
    return plain(timedOut ? 504 : 502, "The calendar could not be loaded right now. Please try again shortly.");
  }

  // The edge function never redirects; if it ever does, something is wrong upstream.
  if (response.status >= 300 && response.status < 400) {
    console.error("calendar-feed upstream sent an unexpected redirect");
    return plain(502, "The calendar could not be loaded right now. Please try again shortly.");
  }

  const publicFeed = query.get("scope") === "public";
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": response.headers.get("Content-Type") ?? "text/plain; charset=utf-8",
    // Calendar apps poll on their own slow schedule, so a short cache costs
    // nothing; token-gated feeds stay private to the subscriber. Errors are
    // never cached, so a fixed token or a recovered backend shows up at once.
    "Cache-Control": response.ok ? (publicFeed ? "public, max-age=300" : "private, max-age=300") : "no-store",
  };

  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}
