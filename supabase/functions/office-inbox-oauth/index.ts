import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { logEdgeError } from "../_shared/error-log.ts";
import { buildAuthUrl, exchangeCode, GmailClient, GoogleAuthError, pkceChallenge, randomToken, revokeToken, sha256Hex } from "../_shared/gmail.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { REFRESH_TOKEN_SECRET } from "../_shared/office-inbox.ts";
import { authenticateInboxAdmin, loadInboxConfig } from "../_shared/office-inbox-env.ts";

/**
 * Connecting the office mailbox (Admin, Integrations, "Office inbox").
 *
 *   POST { action: "start" }       an administrator asks to connect; answers with Google's sign-in
 *                                  address. A one-time state (stored hashed, ten minutes) and a PKCE
 *                                  verifier tie the answer back to this administrator.
 *   GET  ?code=...&state=...       Google sends the browser back here. The code is exchanged, the
 *                                  account must be OFFICE_INBOX_ADDRESS (anything else is refused and
 *                                  its grant revoked), the "Portal imported" label is made, and the
 *                                  refresh token goes into Vault. The browser then returns to the portal.
 *   POST { action: "disconnect" }  revokes the grant at Google (best effort), removes the token from
 *                                  Vault and stops the poll. Imported conversations stay.
 *
 * verify_jwt is off because Google's redirect carries no Supabase session; the POST actions check
 * the session themselves.
 */

function backToPortal(siteUrl: string, outcome: "connected" | "error", reason?: string): Response {
  const url = new URL(`${siteUrl}/family-village/admin`);
  url.searchParams.set("tab", "integrations");
  url.searchParams.set("office_inbox", outcome);
  if (reason) url.searchParams.set("reason", reason);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server not configured" }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const loaded = loadInboxConfig();

  if (req.method === "GET") {
    if (!loaded.ok) return new Response("The office inbox is not set up on this server.", { status: 500 });
    const { config } = loaded;
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (!state) return backToPortal(config.siteUrl, "error", "expired");
    const { data: pending } = await admin.rpc("office_inbox_take_oauth", { p_state_hash: await sha256Hex(state) });
    if (!pending) return backToPortal(config.siteUrl, "error", "expired");
    if (url.searchParams.get("error") || !code) return backToPortal(config.siteUrl, "error", "declined");

    let tokens;
    try {
      tokens = await exchangeCode(fetch, config, code, pending.code_verifier);
    } catch (error) {
      await logEdgeError(admin, "office-inbox-oauth", error, { step: "exchange" });
      return backToPortal(config.siteUrl, "error", error instanceof GoogleAuthError ? "not_allowed" : "google");
    }
    const gmail = new GmailClient(fetch, tokens.accessToken);
    let address: string;
    try {
      address = (await gmail.profile()).emailAddress.trim().toLowerCase();
    } catch (error) {
      await revokeToken(fetch, tokens.refreshToken ?? tokens.accessToken);
      await logEdgeError(admin, "office-inbox-oauth", error, { step: "profile" });
      return backToPortal(config.siteUrl, "error", "google");
    }
    if (address !== config.mailbox) {
      // Only the office mailbox, never anyone's own mail.
      await revokeToken(fetch, tokens.refreshToken ?? tokens.accessToken);
      return backToPortal(config.siteUrl, "error", "wrong_mailbox");
    }
    if (!tokens.refreshToken) return backToPortal(config.siteUrl, "error", "no_refresh_token");
    let labelId: string;
    try {
      labelId = await gmail.ensureLabel();
    } catch (error) {
      await revokeToken(fetch, tokens.refreshToken);
      await logEdgeError(admin, "office-inbox-oauth", error, { step: "label" });
      return backToPortal(config.siteUrl, "error", "google");
    }
    const { error } = await admin.rpc("office_inbox_save_connection", {
      p_user: pending.user_id, p_address: address, p_refresh_token: tokens.refreshToken, p_label_id: labelId,
      p_functions_url: new URL(config.supabaseUrl).origin,
    });
    if (error) {
      await revokeToken(fetch, tokens.refreshToken);
      await logEdgeError(admin, "office-inbox-oauth", new Error(error.message), { step: "save" });
      return backToPortal(config.siteUrl, "error", "save");
    }
    return backToPortal(config.siteUrl, "connected");
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = await authenticateInboxAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => null) as { action?: string } | null;

  if (body?.action === "start") {
    if (!loaded.ok) return json({ error: `The office inbox is not set up yet. Missing function secrets: ${loaded.missing.join(", ")}.` }, 400);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const { error } = await admin.rpc("office_inbox_begin_oauth", {
      p_user: auth.caller.userId, p_state_hash: await sha256Hex(state), p_code_verifier: verifier,
    });
    if (error) return json({ error: error.message }, 403);
    return json({ url: buildAuthUrl(loaded.config, state, await pkceChallenge(verifier), loaded.config.mailbox), mailbox: loaded.config.mailbox });
  }

  if (body?.action === "disconnect") {
    const { data: token } = await admin.rpc("read_vault_secret", { secret_name: REFRESH_TOKEN_SECRET });
    const revoked = token ? await revokeToken(fetch, token as string) : false;
    const { error } = await admin.rpc("office_inbox_clear_connection", { p_user: auth.caller.userId });
    if (error) return json({ error: error.message }, 403);
    return json({ ok: true, revoked });
  }

  if (body?.action === "config") {
    // What the card shows before anyone connects: whether the secrets are in place.
    return json({ ready: loaded.ok, missing: loaded.ok ? [] : loaded.missing, mailbox: loaded.ok ? loaded.config.mailbox : null });
  }

  return json({ error: "Unknown action." }, 400);
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (supabaseUrl && serviceRoleKey) {
        await logEdgeError(createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }), "office-inbox-oauth", error);
      }
      return json({ error: "Something went wrong. This has been logged." }, 500);
    }
  },
};
