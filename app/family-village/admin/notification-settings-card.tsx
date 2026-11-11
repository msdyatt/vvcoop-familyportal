"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type Settings = {
  fallback_hours: number; sms_extra_hours: number; important_kinds: string[]; email_fallback_kinds: string[];
  email_fallback_enabled: boolean; sms_enabled: boolean; sms_provider: string;
};
type SummaryRow = { channel: string; status: string; total: number };

/** The kinds of notification the app makes today, in plain words. Any other kind already in the settings is kept. */
const KIND_LABELS: Record<string, string> = {
  broadcast_urgent: "Urgent broadcasts",
  broadcast_important: "Important broadcasts",
  broadcast_notice: "Notice broadcasts",
  sign_request: "Signature requests",
  compliance_reminder: "Document and dues reminders",
  post_published: "News posts",
  note_added: "Teacher notes",
  message: "Chat messages",
};

const CHANNEL_LABELS: Record<string, string> = { push: "Push", email: "Email", sms: "Text" };

/**
 * How long push gets before email, which notifications fall back to email, and which count as
 * important enough to text. The delivery summary underneath answers "did it go out?".
 */
export default function NotificationSettingsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: rows }] = await Promise.all([
      supabase.from("notification_settings").select("fallback_hours,sms_extra_hours,important_kinds,email_fallback_kinds,email_fallback_enabled,sms_enabled,sms_provider").maybeSingle(),
      supabase.rpc("admin_delivery_summary", { p_days: 7 }),
    ]);
    if (data) setSettings(data as Settings);
    setSummary(((rows ?? []) as SummaryRow[]).map((row) => ({ ...row, total: Number(row.total) })));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  if (!settings) return null;

  const kinds = [...new Set([...Object.keys(KIND_LABELS), ...settings.important_kinds, ...settings.email_fallback_kinds])];
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const toggle = (list: string[], kind: string) => (list.includes(kind) ? list.filter((item) => item !== kind) : [...list, kind]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !settings) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.rpc("admin_update_notification_settings", {
      p_fallback_hours: settings.fallback_hours, p_sms_extra_hours: settings.sms_extra_hours,
      p_important_kinds: settings.important_kinds, p_email_fallback_kinds: settings.email_fallback_kinds,
      p_email_fallback_enabled: settings.email_fallback_enabled, p_sms_enabled: settings.sms_enabled,
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setStatus("Saved. The new rules apply from the next check (every 15 minutes).");
    await load();
  }

  return <article className="integration-card notification-settings-card">
    <div className="integration-card-head"><h3>Email and text fallback</h3></div>
    <p className="field-note">
      Push goes first. If a person hasn&rsquo;t seen an important notification after the wait below, or can&rsquo;t be pushed at all
      (no app, push turned off), it goes to their email, and by text only if they agreed to texts. Nobody is contacted by a channel
      they switched off, and reviewer accounts are never contacted.
    </p>
    <form onSubmit={save} className="household-form">
      <label>Wait before email (hours)
        <input type="number" min={1} max={168} value={settings.fallback_hours} disabled={busy}
          onChange={(event) => set({ fallback_hours: Number(event.target.value) })} />
      </label>
      <label>Extra wait before a text (hours)
        <input type="number" min={0} max={168} value={settings.sms_extra_hours} disabled={busy}
          onChange={(event) => set({ sms_extra_hours: Number(event.target.value) })} />
      </label>
      <fieldset className="notify-kinds">
        <legend>Which notifications</legend>
        <div className="notify-kinds-row notify-kinds-head" aria-hidden><span /><span>Email fallback</span><span>Text (important)</span></div>
        {kinds.map((kind) => <div className="notify-kinds-row" key={kind}>
          <span>{KIND_LABELS[kind] ?? kind}</span>
          <input type="checkbox" aria-label={`${KIND_LABELS[kind] ?? kind}: email fallback`} checked={settings.email_fallback_kinds.includes(kind)} disabled={busy}
            onChange={() => set({ email_fallback_kinds: toggle(settings.email_fallback_kinds, kind) })} />
          <input type="checkbox" aria-label={`${KIND_LABELS[kind] ?? kind}: text`} checked={settings.important_kinds.includes(kind)} disabled={busy}
            onChange={() => set({ important_kinds: toggle(settings.important_kinds, kind) })} />
        </div>)}
      </fieldset>
      <label className="checkbox-field">
        <input type="checkbox" checked={settings.email_fallback_enabled} disabled={busy} onChange={(event) => set({ email_fallback_enabled: event.target.checked })} />
        <b>Email fallback is on</b>
        <span className="field-note">Turn off to stop all fallback emails.</span>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={settings.sms_enabled} disabled={busy} onChange={(event) => set({ sms_enabled: event.target.checked })} />
        <b>Text messages are on</b>
        <span className="field-note">
          {settings.sms_provider === "stub"
            ? "No texting account is connected yet, so nothing is texted even with this on. Texts are queued and recorded as skipped."
            : `Sent through ${settings.sms_provider}.`}
        </span>
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>
    <h4>Last 7 days</h4>
    {summary.length === 0
      ? <p className="field-note">Nothing has been delivered through the fallback yet.</p>
      : <ul className="notify-summary">
          {summary.map((row) => <li key={`${row.channel}-${row.status}`}><b>{row.total}</b> {CHANNEL_LABELS[row.channel] ?? row.channel} {row.status}</li>)}
        </ul>}
  </article>;
}
