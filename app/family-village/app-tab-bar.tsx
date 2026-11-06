"use client";

import { useState } from "react";
import { useUnreadCount } from "./messages/messages-link";
import DetailModal from "./detail-modal";

type Props = {
  roles: string[];
  onOpenAccount: () => void;
  onTour: () => void;
  onSignOut: () => void;
};

const ICONS = {
  home: <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  photos: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>,
  messages: <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
  menu: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

/**
 * Bottom navigation for the installed and native apps (hidden by CSS in an
 * ordinary browser tab). Home, Photos, Messages, and a Menu sheet holding the
 * rest: switching between Family, Teacher and Admin, account, the tour, and
 * signing out.
 */
export default function AppTabBar({ roles, onOpenAccount, onTour, onSignOut }: Props) {
  const unread = useUnreadCount();
  const [menuOpen, setMenuOpen] = useState(false);
  // Where we are, read once per page; every tab is a full page load.
  const [path] = useState(() => (typeof window === "undefined" ? "" : window.location.pathname));

  const inHome = /\/family-village\/(home|teacher|admin)(\/|$)/.test(path);
  const tab = (href: string, label: string, icon: keyof typeof ICONS, active: boolean, badge = 0) =>
    <a key={href} className={`app-tab${active ? " active" : ""}`} href={href} aria-current={active ? "page" : undefined}>
      <span className="app-tab-icon"><Icon name={icon} />{badge > 0 && <span className="app-tab-badge">{badge > 99 ? "99+" : badge}</span>}</span>
      <span className="app-tab-label">{label}</span>
    </a>;

  return <>
    <nav className="app-tabbar" aria-label="Main">
      {tab("/family-village/home", "Home", "home", inHome)}
      {tab("/family-village/photos", "Photos", "photos", path.startsWith("/family-village/photos"))}
      {tab("/family-village/messages", "Messages", "messages", path.startsWith("/family-village/messages"), unread)}
      <button type="button" className="app-tab" onClick={() => setMenuOpen(true)} aria-haspopup="dialog">
        <span className="app-tab-icon"><Icon name="menu" /></span>
        <span className="app-tab-label">Menu</span>
      </button>
    </nav>

    {menuOpen && <DetailModal title="Menu" onClose={() => setMenuOpen(false)}>
      <ul className="app-menu">
        <li><a href="/family-village/home">Family</a></li>
        {roles.includes("teacher") && <li><a href="/family-village/teacher">Teacher&rsquo;s Lounge</a></li>}
        {roles.includes("admin") && <li><a href="/family-village/admin">Administration</a></li>}
        <li><button type="button" onClick={() => { setMenuOpen(false); onOpenAccount(); }}>Account &amp; security</button></li>
        <li><button type="button" onClick={() => { setMenuOpen(false); onTour(); }}>Take the tour</button></li>
        <li><button type="button" onClick={onSignOut}>Sign out</button></li>
      </ul>
    </DetailModal>}
  </>;
}
