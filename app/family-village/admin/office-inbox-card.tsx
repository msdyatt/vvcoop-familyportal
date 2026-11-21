"use client";

import { useAdminAccess } from "../../../lib/admin-access";
import AskBoardAdmin from "./ask-board-admin";
import { useEffect, useState } from "react";
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
type InboxConfig = { ready: boolean; missing: string[]; mailbox: string | null };

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
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<"" | "connect" | "disconnect" | "sync">("");
  const [message, setMessage] = useState("");
  // Connecting or disconnecting the mailbox is board-only (Integrations); checking for mail is not.
  const access = useAdminAccess();
  const canConnect = access.can("integrations");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data, error }, cfg] = await Promise.all([
      supabase.rpc("office_inbox_status"),
      supabase.functions.invoke("office-inbox-oauth", { body: { action: "config" } }),
    ]);
    if (error) { setUnavailable(true); return; }
    setInfo(data as InboxStatus);
    if (!cfg.error && cfg.data) setConfig(cfg.data as InboxConfig);
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
    {config && !config.ready && <p className="office-inbox-warning">Not set up on this server yet. Missing function secrets: {config.missing.join(", ")}. See docs/office-inbox-setup.md.</p>}
    {!connected && config?.ready && config.mailbox && <p className="field-note">When Google asks, sign in as <b>{config.mailbox}</b>, not your own account.</p>}
    <div className="row-actions">
      {!connected && canConnect && <button type="button" disabled={busy !== "" || config?.ready === false} onClick={connect}>{busy === "connect" ? "Opening Google…" : attention ? "Reconnect" : "Connect"}</button>}
      {connected && <button type="button" className="ghost" disabled={busy !== ""} onClick={syncNow}>{busy === "sync" ? "Checking…" : "Check for mail now"}</button>}
      {(connected || attention) && canConnect && <button type="button" className="ghost danger" disabled={busy !== ""} onClick={disconnect}>{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</button>}
    </div>
    {!access.loading && !canConnect && <AskBoardAdmin permission="integrations">Connecting or disconnecting the office mailbox needs the &ldquo;Integrations&rdquo; permission.</AskBoardAdmin>}
    <p className="admin-form-status" role="status">{message}</p>
  </article>;
}
