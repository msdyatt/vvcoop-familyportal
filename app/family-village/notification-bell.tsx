"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { useOutsideClick } from "../../lib/use-outside-click";

type Notification = {
  id: string; kind: string; title: string; body: string | null;
  link_path: string | null; read_at: string | null; created_at: string;
};

const POLL_MS = 60_000;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type Position = { top: number; left: number; width: number };

export default function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /**
   * position:fixed with a JS-measured spot, not CSS right:0.
   *
   * The account menu's dropdown can get away with right:0 because its
   * trigger really is the rightmost thing in the header. The bell sits
   * mid-row instead, so anchoring to its own (narrow) positioning context
   * pushed the dropdown off the left edge on a narrow screen -- confirmed
   * live. Measuring the button's real position and clamping the dropdown's
   * left edge to the viewport is the fix that holds at any width, not just
   * the ones tested by hand.
   */
  function reposition() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
    setPosition({ top: rect.bottom + 8, left, width });
  }

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase
      .from("notifications")
      .select("id,kind,title,body,link_path,read_at,created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    setItems((data ?? []) as Notification[]);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    load();
    // This is the first setInterval-based poll in the codebase -- everywhere
    // else refetches on mount or after a mutation, which doesn't apply here
    // since a notification can arrive from someone else's action at any time.
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useOutsideClick(ref, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open]);

  const unread = items.filter((item) => !item.read_at).length;

  async function markRead(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id);
    setItems((current) => current.map((item) => (item.id === id ? { ...item, read_at: new Date().toISOString() } : item)));
  }

  async function markAllRead() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const unreadIds = items.filter((item) => !item.read_at).map((item) => item.id);
    if (!unreadIds.length) return;
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", unreadIds);
    setItems((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })));
  }

  async function openItem(item: Notification) {
    // Awaited, not fire-and-forget: window.location.assign() below is a real
    // navigation, and browsers abort in-flight requests on navigate -- firing
    // markRead without waiting for it raced the read-receipt write against
    // the page unload often enough that a clicked notification stayed
    // "unread" the next time the bell reloaded.
    if (!item.read_at) await markRead(item.id);
    if (item.link_path) window.location.assign(item.link_path);
    setOpen(false);
  }

  return <div className="notification-bell" ref={ref}>
    <button ref={buttonRef} type="button" className="notification-bell-button" onClick={() => { setOpen((value) => !value); if (!open) load(); }} aria-haspopup="menu" aria-expanded={open} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 3h16l-2-3Z" strokeLinejoin="round" />
        <path d="M9.5 21a2.5 2.5 0 0 0 5 0" strokeLinecap="round" />
      </svg>
      {unread > 0 && <span className="notification-badge">{unread > 9 ? "9+" : unread}</span>}
    </button>
    {open && position && <div className="notification-dropdown" role="menu" style={{ top: position.top, left: position.left, width: position.width }}>
      <div className="notification-dropdown-head">
        <p className="card-kicker">Notifications</p>
        {unread > 0 && <button type="button" onClick={markAllRead}>Mark all read</button>}
      </div>
      {items.length === 0 && <p className="portal-empty">Nothing yet.</p>}
      <ul>
        {items.map((item) => <li key={item.id}>
          <button type="button" className={item.read_at ? "notification-item" : "notification-item unread"} onClick={() => openItem(item)}>
            <span className="notification-item-title">{item.title}</span>
            {item.body && <span className="notification-item-body">{item.body}</span>}
            <span className="notification-item-time">{timeAgo(item.created_at)}</span>
          </button>
        </li>)}
      </ul>
    </div>}
  </div>;
}
