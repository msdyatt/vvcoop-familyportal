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
