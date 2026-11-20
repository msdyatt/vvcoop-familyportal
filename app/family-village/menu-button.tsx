"use client";

import { DRAWER_EVENT } from "../../lib/desktop-nav";
import { useUnreadCount } from "./messages/messages-link";

/**
 * The header's Menu button on a narrow screen in a browser: it opens the sidebar as a drawer (side-nav.tsx).
 * Hidden on desktop, where the sidebar is always there, and in the installed apps, which have their own bar.
 * The dot tells you there are unread messages without opening it.
 */
export default function MenuButton() {
  const unread = useUnreadCount();
  return <button type="button" className="mobile-nav-trigger" aria-haspopup="dialog"
    onClick={() => window.dispatchEvent(new Event(DRAWER_EVENT))}>
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h11M4 17h16" /></svg>
    <span>Menu</span>
    {unread > 0 && <span className="mobile-nav-dot"><span className="sr-only">, {unread} unread {unread === 1 ? "message" : "messages"}</span></span>}
  </button>;
}
