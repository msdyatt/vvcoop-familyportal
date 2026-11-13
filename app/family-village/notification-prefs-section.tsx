"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

type Prefs = {
  push_enabled: boolean; email_enabled: boolean; sms_enabled: boolean; quiet_mode: boolean;
  sms_phone: string | null; sms_consent_at: string | null; sms_opted_out_at: string | null;
};
type Wording = { version: string; text: string };

/** Enough of the number to recognise it, not enough to read out loud. */
function lastFour(phone: string): string {
  return phone.slice(-4);
}

/**
 * Which ways Village notices may reach you, and the separate, explicit agreement for text
 * messages. Device-level push (this phone or computer) is set up in the block above; this is
 * the account-level choice, shared by all devices.
 */
export default function NotificationPrefsSection({ email }: { email: string }) {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [wording, setWording] = useState<Wording | null>(null);
  const [push, setPush] = useState(true);
  const [mail, setMail] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const [reminders, setReminders] = useState(true);
  const [phone, setPhone] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [smsStatus, setSmsStatus] = useState("");

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data: rows }, { data: words }, { data: user }, { data: remindersOn }] = await Promise.all([
      supabase.rpc("my_notification_preferences"),
      supabase.rpc("sms_consent_wording"),
      supabase.auth.getUser(),
      supabase.rpc("my_event_reminders"),
    ]);
    if (typeof remindersOn === "boolean") setReminders(remindersOn);
    const row = (rows as Prefs[] | null)?.[0];
    if (row) { setPrefs(row); setPush(row.push_enabled); setMail(row.email_enabled); setQuiet(row.quiet_mode); }
    if (words) setWording(words as Wording);
    if (user.user && row && !row.sms_phone) {
      const { data: profile } = await supabase.from("profiles").select("phone").eq("id", user.user.id).maybeSingle();
      if (profile?.phone) setPhone(profile.phone);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  async function saveChannels(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus("");
    const { error: prefsError } = await supabase.rpc("set_my_notification_preferences", { p_push: push, p_email: mail, p_quiet: quiet });
    const { error: remindersError } = prefsError ? { error: null } : await supabase.rpc("set_my_event_reminders", { p_on: reminders });
    const error = prefsError ?? remindersError;
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setStatus("Saved.");
    await load();
  }

  async function changeSms(next: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setSmsStatus("");
    const { error } = await supabase.rpc("set_my_sms_consent", { p_phone: phone, p_agree: next });
    setBusy(false);
    if (error) { setSmsStatus(error.message); return; }
    setAgree(false);
    setSmsStatus(next ? "Text messages are on." : "Text messages are off.");
    await load();
  }

  if (!prefs) return null;

  return <div className="settings-block notify-prefs">
    <p className="card-kicker">How we reach you</p>
    <p className="portal-empty">
      An urgent alert (a closure for weather, say) goes out on every way you leave on, right away. Everything else starts with a
      notification on your phone; if you haven&rsquo;t seen an important one after a day, we email it to you.
    </p>
    <form onSubmit={saveChannels} className="household-form">
      <label className="checkbox-field">
        <input type="checkbox" checked={push} disabled={busy} onChange={(event) => setPush(event.target.checked)} />
        <b>Notifications on my devices</b>
        <span className="field-note">Each phone or computer is set up above. Turning this off stops them all.</span>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={mail} disabled={busy} onChange={(event) => setMail(event.target.checked)} />
        <b>Email</b>
        <span className="field-note">{email ? `To ${email}.` : "To the address on your account."}</span>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={quiet} disabled={busy} onChange={(event) => setQuiet(event.target.checked)} />
        <b>Only tell me about urgent things</b>
        <span className="field-note">Routine news and notes wait in the bell. Urgent alerts still reach you.</span>
      </label>
      <label className="checkbox-field">
        <input type="checkbox" checked={reminders} disabled={busy} onChange={(event) => setReminders(event.target.checked)} />
        <b>Event reminders</b>
        <span className="field-note">A reminder 3 days and 1 day before calendar events that are yours to attend. Turn off to stop them; the calendar still shows everything.</span>
      </label>
      <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
      <p className="admin-form-status" role="status">{status}</p>
    </form>

    <p className="card-kicker">Text messages</p>
    {prefs.sms_enabled && prefs.sms_phone
      ? <>
          <p className="portal-empty">Important alerts can be texted to your number ending in {lastFour(prefs.sms_phone)}. {prefs.sms_consent_at ? `You agreed on ${new Date(prefs.sms_consent_at).toLocaleDateString()}.` : ""} You can also stop them any time by replying STOP to a text.</p>
          <div className="print-queue-actions"><button type="button" className="ghost" disabled={busy} onClick={() => void changeSms(false)}>Turn off text messages</button></div>
        </>
      : <form className="household-form" onSubmit={(event) => { event.preventDefault(); void changeSms(true); }}>
          <p className="portal-empty">
            Text messages are optional and only used for important alerts, a few a year at most.
            {prefs.sms_opted_out_at ? " You turned them off before; agreeing again turns them back on." : ""}
          </p>
          <label>Mobile number<input type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(555) 555-0123" disabled={busy} /></label>
          <label className="checkbox-field">
            <input type="checkbox" checked={agree} disabled={busy} onChange={(event) => setAgree(event.target.checked)} />
            <b>I agree</b>
            <span className="field-note">{wording?.text ?? "Loading…"} See our <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a>.</span>
          </label>
          <button disabled={busy || !agree || !phone.trim() || !wording}>{busy ? "Saving…" : "Turn on text messages"}</button>
        </form>}
    <p className="admin-form-status" role="status">{smsStatus}</p>
  </div>;
}
