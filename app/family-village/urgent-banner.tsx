"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";

type Alert = { id: string; title: string; body: string; created_at: string };

const POLL_MS = 60_000;

/**
 * An urgent broadcast, across the top of every signed-in screen, until the person taps "Got it"
 * (or an administrator ends it, or it lapses after 48 hours). The tap is stored, and
 * administrators see how many have tapped. It looks nothing like the rest of the app on purpose.
 */
export default function UrgentBanner() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error: loadError } = await supabase.rpc("my_active_urgent_broadcasts");
    if (!loadError) setAlerts((data ?? []) as Alert[]);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    // Coming back to the app after a while should show a new alert at once, not up to a minute later.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  async function acknowledge(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(id); setError("");
    const { error: ackError } = await supabase.rpc("acknowledge_broadcast", { p_id: id });
    setBusy(null);
    if (ackError) { setError("That didn’t save. Check your connection and tap Got it again."); return; }
    setAlerts((current) => current.filter((alert) => alert.id !== id));
  }

  if (!alerts.length) return null;

  return <div className="urgent-banner-stack">
    {alerts.map((alert) => <section key={alert.id} className="urgent-banner" role="alert" aria-live="assertive">
      <div className="urgent-banner-text">
        <p className="urgent-banner-label"><span aria-hidden>⚠</span> Urgent</p>
        <h2>{alert.title}</h2>
        <p className="urgent-banner-body">{alert.body}</p>
      </div>
      <button type="button" className="urgent-banner-ack" disabled={busy === alert.id} onClick={() => void acknowledge(alert.id)}>
        {busy === alert.id ? "Saving…" : "Got it"}
      </button>
    </section>)}
    {error && <p className="urgent-banner-error" role="status">{error}</p>}
  </div>;
}
