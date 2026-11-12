"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { timeAgo } from "../notification-bell";
import UrgentBanner from "../urgent-banner";

type Notification = {
  id: string; kind: string; title: string; body: string | null;
  link_path: string | null; read_at: string | null; created_at: string;
};

/** The same rows and the same actions as the bell's dropdown, without a header: the iPhone frame supplies the bar. */
export default function NotificationsApp() {
  const [items, setItems] = useState<Notification[] | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { window.location.assign("/family-village"); return; }
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { window.location.assign("/family-village"); return; }
    const { data } = await supabase.from("notifications").select("id,kind,title,body,link_path,read_at,created_at").order("created_at", { ascending: false }).limit(50);
    setItems((data ?? []) as Notification[]);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  async function open(item: Notification) {
    const supabase = getSupabaseBrowserClient();
    // Awaited: the navigation below can cancel a request still in flight.
    if (!item.read_at && supabase) await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", item.id);
    if (item.link_path) window.location.assign(item.link_path);
    else setItems((current) => current?.map((row) => (row.id === item.id ? { ...row, read_at: row.read_at ?? new Date().toISOString() } : row)) ?? null);
  }

  async function markAllRead() {
    const supabase = getSupabaseBrowserClient();
    const ids = (items ?? []).filter((item) => !item.read_at).map((item) => item.id);
    if (!supabase || !ids.length) return;
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
    setItems((current) => current?.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })) ?? null);
  }

  const unread = (items ?? []).filter((item) => !item.read_at).length;

  return <main className="notifications-page">
    <UrgentBanner />
    {items === null && <p className="portal-empty">Loading…</p>}
    {items && items.length === 0 && <p className="portal-empty">Nothing yet.</p>}
    {unread > 0 && <button type="button" className="notifications-markall" onClick={markAllRead}>Mark all read</button>}
    <ul>
      {(items ?? []).map((item) => <li key={item.id}>
        <button type="button" className={item.read_at ? "notification-item" : "notification-item unread"} onClick={() => open(item)}>
          <span className="notification-item-title">{item.title}</span>
          {item.body && <span className="notification-item-body">{item.body}</span>}
          <span className="notification-item-time">{timeAgo(item.created_at)}</span>
        </button>
      </li>)}
    </ul>
  </main>;
}
