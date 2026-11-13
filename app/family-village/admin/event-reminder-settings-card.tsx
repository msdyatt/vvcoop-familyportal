"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { reminderLine, type ReminderRow } from "./event-reminders";

type Settings = { enabled: boolean; send_time: string; offsets_days: number[]; timezone: string; test_recipients: string[] };

/** "3, 1" -> [3, 1]; anything that is not a whole number is dropped and the server checks the rest. */
function parseOffsets(text: string): number[] {
  return text.split(/[\s,]+/).filter(Boolean).map(Number).filter((value) => Number.isInteger(value));
}

/**
 * The automatic event reminders: on or off, what time of day, how many days before, a test mode that sends
 * only to chosen people, and a list of what is about to go out so nothing is a surprise.
 */
export default function EventReminderSettingsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [sendTime, setSendTime] = useState("09:00");
  const [offsets, setOffsets] = useState("3, 1");
  const [testEmails, setTestEmails] = useState("");
  const [upcoming, setUpcoming] = useState<ReminderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data }, { data: emails }, { data: rows }] = await Promise.all([
      supabase.from("event_reminder_settings").select("enabled,send_time,offsets_days,timezone,test_recipients").maybeSingle(),
      supabase.rpc("admin_event_reminder_test_emails"),
      supabase.rpc("admin_upcoming_event_reminders", { p_days: 21 }),
    ]);
    if (data) {
      const row = data as Settings;
      setSettings(row); setEnabled(row.enabled); setSendTime(row.send_time.slice(0, 5)); setOffsets(row.offsets_days.join(", "));
    }
    setTestEmails(((emails ?? []) as string[]).join(", "));
    setUpcoming((rows ?? []) as ReminderRow[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  if (!settings) return null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.rpc("admin_update_event_reminder_settings", {
      p_enabled: enabled, p_send_time: sendTime, p_offsets: parseOffsets(offsets),
      p_test_emails: testEmails.split(/[\s,;]+/).filter(Boolean),
    });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setStatus("Saved. Reminders already sent are not sent again.");
    await load();
  }

  const byEvent = new Map<string, ReminderRow[]>();
  for (const row of upcoming) byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row]);
  const testMode = settings.test_recipients.length > 0;

  return <article className="integration-card event-reminder-card">
    <div className="integration-card-head"><h3>Event reminders</h3></div>
    <p className="field-note">
      Everyone who can see a calendar event gets a reminder before it: families of a class for that class&rsquo;s events, everyone
      for co-op-wide events. They arrive in the bell and as a push notification, and follow each person&rsquo;s own settings (a
      person can switch event reminders off, and &ldquo;only urgent things&rdquo; keeps them in the bell). They are never emailed or
      texted unless you tick Event reminders under Email and text fallback. Reminder times are Central time.
    </p>
    {testMode && <p className="schedule-held" role="alert">Test mode is on: reminders go only to {settings.test_recipients.length} chosen {settings.test_recipients.length === 1 ? "person" : "people"}. Clear the list below to send to everyone.</p>}
    <form onSubmit={save} className="household-form">
      <label className="checkbox-field">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />
        <b>Send event reminders</b>
        <span className="field-note">Turn off to stop all of them. A reminder missed while off is not sent late.</span>
      </label>
      <label>Time of day (Central)<input type="time" required min="06:00" max="21:00" value={sendTime} onChange={(event) => setSendTime(event.target.value)} disabled={busy} /></label>
      <label>Days before the event<input value={offsets} onChange={(event) => setOffsets(event.target.value)} disabled={busy} placeholder="3, 1" />
        <span className="field-note">Up to three numbers between 0 and 30, such as 3, 1. 0 means the morning of the event.</span></label>
      <label>Test mode: only send to these emails<textarea value={testEmails} onChange={(event) => setTestEmails(event.target.value)} disabled={busy} placeholder="Leave empty to send to everyone" />
        <span className="field-note">Use this to try reminders safely with test accounts. Everyone else is skipped while it is on.</span></label>
      <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>

    <p className="card-kicker">Coming up (next 3 weeks)</p>
    {byEvent.size ? <ul className="reminder-upcoming">{[...byEvent.values()].map((rows) => <li key={rows[0].event_id}>
      <b>{rows[0].event_title}</b>
      <span>{new Date(`${rows[0].event_date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}{rows[0].class_title ? ` · ${rows[0].class_title}` : ""}</span>
      {rows.map((row) => <small key={row.offset_days} className={row.status === "skipped" ? "reminder-skipped" : undefined}>{reminderLine(row)}</small>)}
    </li>)}</ul>
      : <p className="portal-empty">No reminders are planned. Events with “Send reminders” on appear here once they are within three weeks.</p>}
  </article>;
}
