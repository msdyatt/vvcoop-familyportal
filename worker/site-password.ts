/**
 * Shared-password gate for the public site.
 *
 * This lives in the worker, ahead of the app router, so it covers every route
 * and every rendering path rather than depending on a page remembering to check.
 *
 * Why it is here at all: the gate used to exist only in a deployed worker build
 * that was never committed, so the first `wrangler deploy` from this repository
 * silently replaced it and the site went public. Keeping it in version control
 * is the whole point -- it now survives every deploy.
 *
 * It stays on until the code is deliberately changed. There is no "disabled"
 * flag to trip over.
 *
 * Configuration, both already set as worker secrets:
 *   SITE_PASSWORD     the shared password
 *   SITE_AUTH_SECRET  HMAC key for the session cookie, so the password itself
 *                     is never stored in the browser
 */

const COOKIE_NAME = "vv_site_access";
const FORM_PATH = "/site-access";
/** Thirty days, so a family is not re-prompted on every visit. */
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export type SitePasswordEnv = {
  SITE_PASSWORD?: string;
  SITE_AUTH_SECRET?: string;
};

/**
 * Paths that bypass the gate.
 *
 * `/family-village` is the private portal. It has its own Supabase
 * authentication, and stacking a shared password on top would mean families
 * entering two credentials to reach their own records. The gate exists to keep
 * the public marketing site private, which is what it does.
 *
 * `/privacy` and `/terms` are exempt on purpose -- a privacy policy or terms
 * page that requires a password to even read defeats the point of having
 * one; both are expected to be freely readable by anyone, not just members.
 *
 * Static assets are exempt so the gate page itself can render, and because they
 * carry no content worth withholding once the HTML is protected.
 */
function isExempt(pathname: string): boolean {
  return (
    pathname === FORM_PATH ||
    pathname.startsWith("/family-village") ||
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/_vinext/") ||
    pathname.startsWith("/brand/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

function bytesToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

/** Constant-time comparison, so a wrong value cannot be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * The cookie carries an issue timestamp and its HMAC. Re-signing on every check
 * means rotating SITE_AUTH_SECRET invalidates every outstanding session.
 */
async function hasValidSession(request: Request, secret: string): Promise<boolean> {
  const cookie = readCookie(request, COOKIE_NAME);
  if (!cookie) return false;
  const [issuedAt, signature] = decodeURIComponent(cookie).split(".");
  if (!issuedAt || !signature) return false;

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  if (Date.now() / 1000 - issued > SESSION_SECONDS) return false;

  return safeEqual(signature, await sign(issuedAt, secret));
}

async function sessionCookie(secret: string): Promise<string> {
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const value = `${issuedAt}.${await sign(issuedAt, secret)}`;
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function gatePage(returnTo: string, error: boolean, status: number): Response {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Veritas Village</title>
<link rel="icon" href="/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Playfair+Display:wght@600&display=swap">
<style>
  :root{--navy:#0b2a3d;--cream:#faf7f1;--terracotta:#bb6141;--terracotta-text:#a85539;--sage-text:#5f6b61}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
       background:var(--cream);color:var(--navy);
       font:16px/1.6 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{width:min(400px,100%);display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px}
  img{width:min(280px,72vw);height:auto}
  p.eyebrow{margin:14px 0 0;color:var(--terracotta-text);font-size:12px;font-weight:600;
            letter-spacing:.16em;text-transform:uppercase}
  h1{margin:2px 0 4px;font:600 30px/1.2 "Playfair Display",Georgia,serif}
  p.lead{margin:0 0 18px;color:var(--sage-text);font-size:15px}
  form{display:flex;flex-direction:column;gap:10px;width:100%}
  input{width:100%;padding:13px 14px;background:#fff;color:var(--navy);
        font:16px Inter,system-ui,sans-serif;border:1px solid rgba(11,42,61,.22);border-radius:2px}
  input:focus-visible{outline:2px solid var(--terracotta);outline-offset:1px}
  button{padding:13px 16px;background:var(--navy);color:var(--cream);
         font:600 15px Inter,system-ui,sans-serif;border:0;border-radius:2px;cursor:pointer}
  button:focus-visible{outline:2px solid var(--terracotta);outline-offset:2px}
  .error{margin:0;padding:10px 12px;background:#f4e4dc;color:#6b3826;font-size:14px;text-align:left}
  small{margin-top:16px;color:var(--sage-text);font-size:13px}
  a{color:var(--terracotta-text)}
</style>
</head><body>
<main>
  <img src="/brand/lockup-stacked-navy.png" alt="Veritas Village" width="760" height="769">
  <p class="eyebrow">Private</p>
  <h1>This site is password protected.</h1>
  <p class="lead">Enter the shared password to continue.</p>
  ${error ? '<p class="error">That password was not correct. Please try again.</p>' : ""}
  <form method="POST" action="${FORM_PATH}">
    <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
    <label for="pw" style="position:absolute;left:-9999px">Password</label>
    <input id="pw" name="password" type="password" autocomplete="current-password"
           autofocus required placeholder="Password">
    <button type="submit">Enter</button>
  </form>
  <small>Already a member family? <a href="/family-village">Sign in to Family Village</a></small>
</main>
</body></html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/** Keeps a redirect on this site -- never let return_to bounce to another origin. */
function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * Returns a Response when the request should be intercepted, or null to let it
 * through to the app.
 */
export async function guardRequest(request: Request, env: SitePasswordEnv): Promise<Response | null> {
  const password = env.SITE_PASSWORD;
  const secret = env.SITE_AUTH_SECRET;
  const url = new URL(request.url);

  // Fail closed. If the gate is misconfigured the site stays shut rather than
  // quietly serving to the public -- which is exactly how it came unlocked
  // before. The message says what to fix.
  if (!password || !secret) {
    if (isExempt(url.pathname) && url.pathname !== FORM_PATH) return null;
    return new Response(
      "This site is password protected, but the gate is not configured. Set the SITE_PASSWORD and SITE_AUTH_SECRET worker secrets.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  if (url.pathname === FORM_PATH) {
    if (request.method !== "POST") return gatePage("/", false, 405);
    const form = await request.formData();
    const submitted = String(form.get("password") ?? "");
    const returnTo = safeReturnTo(String(form.get("return_to") ?? "/"));

    if (!safeEqual(submitted, password)) return gatePage(returnTo, true, 401);

    return new Response(null, {
      status: 303,
      headers: { Location: returnTo, "Set-Cookie": await sessionCookie(secret), "Cache-Control": "no-store" },
    });
  }

  if (isExempt(url.pathname)) return null;
  if (await hasValidSession(request, secret)) return null;

  return gatePage(`${url.pathname}${url.search}`, false, 401);
}
