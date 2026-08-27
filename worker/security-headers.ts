/**
 * Two worker-level concerns that belong ahead of the app, same reasoning as
 * site-password.ts: living here means every route gets them regardless of
 * whether any given page remembers to, and it survives every deploy since
 * this file is real source, not generated build output.
 */

/**
 * Redirects a plain-HTTP request to its HTTPS equivalent.
 *
 * Checks both the request's own URL scheme and X-Forwarded-Proto -- which one
 * actually reflects the client's original connection depends on exactly how
 * Cloudflare hands the request to the worker, and getting this wrong in
 * either direction either misses real HTTP requests or redirect-loops an
 * already-HTTPS one, so both are checked rather than assuming one.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  // localhost/127.0.0.1 is never a real client -- it's `wrangler dev` and the
  // test suite (tests/rendered-html.test.mjs calls the worker directly over
  // plain http://localhost). Redirecting those would just break local
  // development and every test, for a scheme no real visitor ever uses here.
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (url.protocol !== "http:" && forwardedProto !== "http") return null;
  url.protocol = "https:";
  return Response.redirect(url.toString(), 301);
}

/**
 * Adds the response headers a browser security scan expects and this site
 * was missing entirely: HSTS, MIME-sniffing protection, a conservative
 * Referrer-Policy, a Permissions-Policy turning off device APIs nothing here
 * uses, X-Frame-Options, and a Content-Security-Policy in **report-only**
 * mode.
 *
 * Report-only, not enforced: a blocking CSP guessed at without first seeing
 * what it would actually break (inline styles this codebase uses throughout,
 * whatever vinext's own hydration/RSC payloads need) risks taking the whole
 * site down on a wrong guess. This starts collecting real violations in the
 * browser console/devtools without changing anything else; enforcing it is a
 * deliberate follow-up once that's been watched for a while.
 */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy-Report-Only",
    [
      "default-src 'self'",
      "connect-src 'self' https://jtwemgyhxylbhjzxgyvh.supabase.co",
      "img-src 'self' data: blob: https://jtwemgyhxylbhjzxgyvh.supabase.co",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
