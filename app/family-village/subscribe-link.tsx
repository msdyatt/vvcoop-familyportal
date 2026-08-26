"use client";

import { useEffect, useState } from "react";
import { calendarSubscribeUrl, getSupabaseBrowserClient, googleCalendarAddUrl } from "../../lib/supabase";

/**
 * A calendar feed's two subscribe actions, styled identically since they're
 * equally the point rather than one being a fallback: webcal:// opens Apple
 * Calendar/Outlook's own "Subscribe" prompt directly (see
 * calendarSubscribeUrl for why that -- not a plain https:// link -- is what
 * keeps refreshing instead of downloading a one-time file); Google's own
 * "Add by URL" flow opens the same way via its cid= deep link, one click
 * instead of a copy-paste into Settings -> Add calendar -> From URL.
 */
export default function SubscribeLink({ query, label = "Subscribe to this calendar" }: { query: string; label?: string }) {
  return <span className="subscribe-link">
    <a className="compliance-cta ghost" href={calendarSubscribeUrl(query)}>{label} ↗</a>
    <a className="compliance-cta ghost" href={googleCalendarAddUrl(query)} target="_blank" rel="noreferrer">Add to Google Calendar ↗</a>
  </span>;
}

/**
 * The signed-in person's own personal feed (see calendar-feed's
 * ?scope=personal), looked up by user id. Regenerating the link (a leaked
 * link is invalidated by getting a new one, rather than anyone having to
 * notice and revoke it) lives in Account Settings only, not here -- this is
 * meant to sit inline wherever "here's your calendar" is useful, and a
 * destructive-ish control didn't belong crowding that.
 */
export function PersonalSubscribeLink({ userId }: { userId: string }) {
  const [token, setToken] = useState<string | null>(null);

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

  if (!token) return null;
  return <SubscribeLink query={`scope=personal&token=${token}`} label="Subscribe to your calendar" />;
}
