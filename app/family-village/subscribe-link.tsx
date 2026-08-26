"use client";

import { useEffect, useState } from "react";
import { calendarFeedUrl, calendarSubscribeUrl, getSupabaseBrowserClient } from "../../lib/supabase";

/**
 * A calendar feed's subscribe action -- one click via webcal:// for Apple
 * Calendar/Outlook (see calendarSubscribeUrl for why that's the link that
 * actually opens a live subscription rather than a one-time download), plus
 * a copy button for the plain https:// form Google Calendar's "Other
 * calendars -> From URL" import wants instead.
 */
export default function SubscribeLink({ query, label = "Subscribe to this calendar" }: { query: string; label?: string }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(calendarFeedUrl(query));
      setStatus("Link copied.");
    } catch {
      setStatus("Could not copy automatically.");
    }
  }

  return <span className="subscribe-link">
    <a className="compliance-cta ghost" href={calendarSubscribeUrl(query)}>{label} ↗</a>
    <button type="button" className="ghost" onClick={copy}>Copy link for Google Calendar</button>
    {status && <small role="status">{status}</small>}
  </span>;
}

/**
 * The signed-in person's own personal feed (see calendar-feed's
 * ?scope=personal), looked up by user id, with a "Get a new link" control --
 * a leaked link is invalidated by regenerating rather than by anyone having
 * to notice and revoke it.
 */
export function PersonalSubscribeLink({ userId }: { userId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.from("profiles").select("calendar_token").eq("id", userId).single();
      if (!cancelled) setToken(data?.calendar_token ?? null);
    }
    load();
    return () => { cancelled = true; };
  }, [userId]);

  async function regenerate() {
    if (!confirm("Get a new link? The old one will stop working.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("regenerate_calendar_token");
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setToken(data as string);
    setMessage("New link ready.");
  }

  if (!token) return null;
  return <span className="subscribe-link">
    <SubscribeLink query={`scope=personal&token=${token}`} label="Subscribe to your calendar" />
    <button type="button" className="ghost" onClick={regenerate} disabled={busy}>{busy ? "Working…" : "Get a new link"}</button>
    {message && <small role="status">{message}</small>}
  </span>;
}
