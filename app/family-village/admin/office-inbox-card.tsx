"use client";

import { useAdminAccess } from "../../../lib/admin-access";
import AskBoardAdmin from "./ask-board-admin";
import { FormEvent, useEffect, useState } from "react";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";
import { formatCoopDateTime } from "../../../lib/coop-time";

type InboxStatus = {
  status: "disconnected" | "connected" | "attention";
  mailbox_address: string | null;
  connected_at: string | null;
  connected_by: string | null;
  last_sync_at: string | null;
  last_sync_error: string | null;
  last_sync_imported: number | null;
};
type InboxConfig = { ready: boolean; missing: string[]; mailbox: string | null; redirectUri?: string };
type Setup = { google_client_id: string | null; client_secret_saved: boolean; allowed_mailbox: string | null; portal_site_url: string | null };

const SETTING_NAMES: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT_ID: "Google client ID",
  GOOGLE_OAUTH_CLIENT_SECRET: "Google client secret",
  OFFICE_INBOX_ADDRESS: "Office mailbox",
  PORTAL_SITE_URL: "Portal address",
  SUPABASE_URL: "the server address (a hosting problem, not a setting here)",
};
function settingName(raw: string): string {
  const [name, ...rest] = raw.split(" ");
  return `${SETTING_NAMES[name] ?? name}${rest.length ? ` ${rest.join(" ")}` : ""}`;
}

const RETURN_REASONS: Record<string, string> = {
  expired: "The sign-in took too long or was already used. Press Connect again.",
  declined: "Google access was not allowed, so nothing was connected.",
  wrong_mailbox: "That Google account is not the office mailbox. Sign in as the office mailbox itself, not your own account.",
  not_allowed: "Google refused the request. Check the OAuth client and that the consent screen is set to Internal.",
  no_refresh_token: "Google did not return a lasting authorisation. Press Connect again and allow access.",
  google: "Google could not be reached. Try again in a minute.",
  save: "The connection could not be saved. Try again; if it keeps failing, check the error log.",
};

/**
 * Admin, Integrations: the office mailbox (Gmail API). Connect sends the administrator to
 * Google; the refresh token is stored server-side only, never here. See docs/office-inbox-setup.md.
 */
export default function OfficeInboxCard() {
  const [info, setInfo] = useState<InboxStatus | null>(null);
  const [config, setConfig] = useState<InboxConfig | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<"" | "connect" | "disconnect" | "sync">("");
  const [message, setMessage] = useState("");
  // Connecting or disconnecting the mailbox is board-only (Integrations); checking for mail is not.
  const access = useAdminAccess();
  const canConnect = access.can("integrations");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, cfg, saved] = await Promise.all([
      supabase.rpc("office_inbox_status"),
      supabase.functions.invoke("office-inbox-oauth", { body: { action: "config" } }),
      supabase.rpc("office_inbox_setup"),
    ]);
    if (error) { setUnavailable(true); return; }
    setInfo(data as InboxStatus);
    if (!saved.error) setSetup(saved.data as Setup);
    if (!cfg.error && cfg.data) {
      setConfig(cfg.data as InboxConfig);
      if (!(cfg.data as InboxConfig).ready) setSetupOpen(true);
    }
  }

  useEffect(() => {
    // Coming back from Google: show the outcome once, then tidy the address.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("office_inbox");
    if (outcome) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of the return address
      setMessage(outcome === "connected"
        ? "The office inbox is connected. The first import of the last 30 days starts within a minute."
        : RETURN_REASONS[params.get("reason") ?? ""] ?? "The office inbox could not be connected.");
      params.delete("office_inbox");
      params.delete("reason");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
    load();
  }, []);

  async function connect() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy("connect");
    setMessage("Opening Google sign-in…");
    const { data, error } = await supabase.functions.invoke("office-inbox-oauth", { body: { action: "start" } });
    if (error || !data?.url) {
      setBusy("");
      setMessage(await functionErrorMessage(error, data, "Could not start connecting the office inbox."));
      return;
    }
    window.location.assign(data.url as string);
  }

  async function disconnect() {
    if (!confirm("Disconnect the office inbox? New mail stops arriving in the portal and the stored Google authorisation is removed. Conversations already here stay.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy("disconnect");
    const { data, error } = await supabase.functions.invoke("office-inbox-oauth", { body: { action: "disconnect" } });
    setBusy("");
    if (error || data?.error) { setMessage(await functionErrorMessage(error, data, "Could not disconnect the office inbox.")); return; }
    setMessage("The office inbox is disconnected.");
    await load();
  }

  async function syncNow() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy("sync");
    setMessage("Checking for new mail…");
    const { data, error } = await supabase.functions.invoke("office-inbox-sync", { body: { mode: "now" } });
    setBusy("");
    if (error || data?.error) { setMessage(await functionErrorMessage(error, data, "Could not check for new mail.")); return; }
    if (!data?.ran) setMessage("A check is already running. Try again in a minute.");
    else if (data.error) setMessage(`Checked, with a problem: ${data.error}`);
    else setMessage(data.imported ? `Imported ${data.imported} new message${data.imported === 1 ? "" : "s"}.${data.remaining ? ` ${data.remaining} more on the next run.` : ""}` : "No new mail.");
    await load();
  }

  if (unavailable) return null;

  const connected = info?.status === "connected";
  const attention = info?.status === "attention";
  const statusText = connected ? "Connected" : attention ? "Needs attention" : "Not connected";

  return <article className="integration-card office-inbox-card">
    <div className="integration-card-head">
      <h3>Office inbox</h3>
      <span className={`office-inbox-state ${info?.status ?? "disconnected"}`}>{statusText}</span>
    </div>
    <p className="field-note">The co-op&rsquo;s office email in the portal (Admin, Office inbox). Only the office mailbox is read; mail is never deleted in Gmail.</p>
    {info?.mailbox_address && <dl className="office-inbox-facts">
      <div><dt>Mailbox</dt><dd>{info.mailbox_address}</dd></div>
      {info.connected_at && <div><dt>Connected</dt><dd>{formatCoopDateTime(info.connected_at)}{info.connected_by ? ` by ${info.connected_by}` : ""}</dd></div>}
      <div><dt>Last check</dt><dd>{info.last_sync_at ? formatCoopDateTime(info.last_sync_at) : "Not yet"}</dd></div>
    </dl>}
    {attention && <p className="office-inbox-warning">Google stopped accepting the stored authorisation (a password change, a revoked grant or a suspended account). Connect again to resume.</p>}
    {info?.last_sync_error && !attention && <p className="field-note">Last problem: {info.last_sync_error}</p>}
    {config && !config.ready && <p className="office-inbox-warning">Not set up yet. Still needed: {config.missing.map(settingName).join(", ")}. Fill them in under Google setup below.</p>}
    {!connected && config?.ready && config.mailbox && <p className="field-note">When Google asks, sign in as <b>{config.mailbox}</b>, not your own account.</p>}
    <div className="row-actions">
      {!connected && canConnect && <button type="button" disabled={busy !== "" || config?.ready === false} onClick={connect}>{busy === "connect" ? "Opening Google…" : attention ? "Reconnect" : "Connect"}</button>}
      {connected && <button type="button" className="ghost" disabled={busy !== ""} onClick={syncNow}>{busy === "sync" ? "Checking…" : "Check for mail now"}</button>}
      {(connected || attention) && canConnect && <button type="button" className="ghost danger" disabled={busy !== ""} onClick={disconnect}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>}
      {setup && canConnect && <button type="button" className="ghost" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? "Hide Google setup" : "Google setup"}</button>}
    </div>
    {!access.loading && !canConnect && <AskBoardAdmin permission="integrations">Connecting, disconnecting or setting up the office mailbox needs the &ldquo;Integrations&rdquo; permission.</AskBoardAdmin>}
    {setup && setupOpen && canConnect && <SetupForm setup={setup} redirectUri={config?.redirectUri ?? null} connectedMailbox={connected || attention ? info?.mailbox_address ?? null : null}
      onSaved={async (text) => { setMessage(text); await load(); }} onError={setMessage} />}
    <p className="admin-form-status" role="status">{message}</p>
  </article>;
}

/**
 * The four values the office inbox needs, entered here instead of as Edge Function secrets.
 * The client secret is write-only: once saved it is kept in Vault and never shown again; leave the
 * box empty to keep it. Anything left blank falls back to the function secret of the same name.
 */
function SetupForm({ setup, redirectUri, connectedMailbox, onSaved, onError }: {
  setup: Setup; redirectUri: string | null; connectedMailbox: string | null;
  onSaved: (message: string) => Promise<void>; onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState(setup.google_client_id ?? "");
  const [secret, setSecret] = useState("");
  const [mailbox, setMailbox] = useState(setup.allowed_mailbox ?? connectedMailbox ?? "");
  const [site, setSite] = useState(setup.portal_site_url ?? (typeof window === "undefined" ? "" : window.location.origin));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function save(event: FormEvent, clearSecret = false) {
    event.preventDefault();
    if (clearSecret && !confirm("Remove the saved Google client secret? The office inbox stops working until a new one is saved (or set as a function secret).")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.rpc("office_inbox_save_setup", {
      p_client_id: clientId, p_client_secret: clearSecret ? null : secret, p_allowed_mailbox: mailbox, p_portal_site_url: site, p_clear_secret: clearSecret,
    });
    setBusy(false);
    if (error) { onError(error.message); return; }
    setSecret("");
    await onSaved(clearSecret ? "The client secret was removed." : "Google setup saved.");
  }

  async function copy() {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Could not copy. Select the address and copy it by hand.");
    }
  }

  return <form className="office-inbox-setup" onSubmit={(e) => save(e)}>
    <p className="field-note">From the co-op&rsquo;s Google Cloud project (docs/office-inbox-setup.md, steps 2 to 4). Blank boxes use the Supabase function secret of the same name, if one is set.</p>
    {redirectUri && <div className="office-inbox-redirect">
      <span className="field-caption">Authorised redirect URI to add to the Google OAuth client</span>
      <code>{redirectUri}</code>
      <button type="button" className="ghost" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>}
    <label>Google client ID
      <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} disabled={busy} />
    </label>
    <label>Google client secret
      <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} disabled={busy}
        placeholder={setup.client_secret_saved ? "Saved. Leave blank to keep it." : "Paste the client secret"} />
    </label>
    {setup.client_secret_saved && <p className="field-note">A client secret is saved. It is kept in Supabase Vault and is never shown again.{" "}
      <button type="button" className="linklike" disabled={busy} onClick={(e) => save(e, true)}>Remove it</button></p>}
    <label>Office mailbox
      <input type="email" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="office@veritasvillage.org" autoComplete="off" disabled={busy || Boolean(connectedMailbox)} />
    </label>
    {connectedMailbox && <p className="field-note">Disconnect first to change which mailbox the portal reads.</p>}
    <label>Portal address
      <input type="url" value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://family.veritasvillage.org" autoComplete="off" disabled={busy} />
    </label>
    <div className="row-actions">
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Google setup"}</button>
    </div>
  </form>;
}
