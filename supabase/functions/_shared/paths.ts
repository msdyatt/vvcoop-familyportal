/**
 * A notification's link is always a path on this site. Anything else -- an
 * absolute URL, a protocol-relative "//host", a "javascript:" string, nothing
 * at all -- becomes the home page, so a bad row can never send someone
 * elsewhere when they tap it.
 */
export function safePath(path: string | null | undefined): string {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
    ? path
    : "/family-village/home";
}

/**
 * Adds the notification's id to the link a push tap opens, as ?vvn=<id>. When the page
 * loads, the app tells the server "this one was opened" and the fallback ladder stops
 * waiting on it. The path itself is vetted first, so this can only ever point at this site.
 */
export function withOpenMarker(path: string | null | undefined, notificationId: string): string {
  const safe = safePath(path);
  const hash = safe.indexOf("#");
  const base = hash >= 0 ? safe.slice(0, hash) : safe;
  const fragment = hash >= 0 ? safe.slice(hash) : "";
  return `${base}${base.includes("?") ? "&" : "?"}vvn=${encodeURIComponent(notificationId)}${fragment}`;
}
