import { authenticate, type Caller } from "./auth.ts";
import { json } from "./http.ts";

/**
 * Settings the office-inbox functions read from Edge Function secrets (set by the owner in the
 * Supabase dashboard, once per project: staging and production each have their own):
 *
 *   GOOGLE_OAUTH_CLIENT_ID      the web OAuth client from the co-op's Google Cloud project
 *   GOOGLE_OAUTH_CLIENT_SECRET  its secret
 *   OFFICE_INBOX_ADDRESS        the one mailbox that may be connected (office@...); any other
 *                               Google account is refused, so nobody's personal mail is read
 *   PORTAL_SITE_URL             this environment's portal (https://family.veritasvillage.org, or
 *                               the staging address), where the browser returns after connecting
 *
 * SUPABASE_URL is provided by Supabase itself.
 */
export type InboxConfig = {
  clientId: string;
  clientSecret: string;
  mailbox: string;
  siteUrl: string;
  supabaseUrl: string;
  redirectUri: string;
};

export function loadInboxConfig(env: (name: string) => string | undefined = (n) => Deno.env.get(n)):
  { ok: true; config: InboxConfig } | { ok: false; missing: string[] } {
  const read = (name: string) => (env(name) ?? "").trim();
  const values = {
    GOOGLE_OAUTH_CLIENT_ID: read("GOOGLE_OAUTH_CLIENT_ID"),
    GOOGLE_OAUTH_CLIENT_SECRET: read("GOOGLE_OAUTH_CLIENT_SECRET"),
    OFFICE_INBOX_ADDRESS: read("OFFICE_INBOX_ADDRESS").toLowerCase(),
    PORTAL_SITE_URL: read("PORTAL_SITE_URL").replace(/\/+$/, ""),
    SUPABASE_URL: read("SUPABASE_URL").replace(/\/+$/, ""),
  };
  const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k);
  if (values.OFFICE_INBOX_ADDRESS && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.OFFICE_INBOX_ADDRESS)) missing.push("OFFICE_INBOX_ADDRESS (not an email address)");
  if (values.PORTAL_SITE_URL && !/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(values.PORTAL_SITE_URL)) {
    missing.push("PORTAL_SITE_URL (must be https://host with no path)");
  }
  if (missing.length) return { ok: false, missing };
  return {
    ok: true,
    config: {
      clientId: values.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: values.GOOGLE_OAUTH_CLIENT_SECRET,
      mailbox: values.OFFICE_INBOX_ADDRESS,
      siteUrl: values.PORTAL_SITE_URL,
      supabaseUrl: values.SUPABASE_URL,
      redirectUri: `${values.SUPABASE_URL}/functions/v1/office-inbox-oauth`,
    },
  };
}

/** An active administrator with the second factor passed, and not a reviewer account. */
export async function authenticateInboxAdmin(req: Request): Promise<{ ok: true; caller: Caller } | { ok: false; response: Response }> {
  const auth = await authenticate(req, { adminOnly: true });
  if (!auth.ok) return auth;
  const { data: profile } = await auth.caller.admin.from("profiles").select("is_demo").eq("id", auth.caller.userId).single();
  if (!profile || profile.is_demo) return { ok: false, response: json({ error: "Administrator access is required." }, 403) };
  return auth;
}
