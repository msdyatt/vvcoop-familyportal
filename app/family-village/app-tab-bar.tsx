"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import {
  availableDestinations, cleanPrefs, isActive, readCachedPrefs, readLastSection, resolveBar, writeCachedPrefs, writeLastSection,
  type IconName, type NavPrefs, type Section,
} from "../../lib/nav-prefs";
import { useUnreadCount } from "./messages/messages-link";
import BarCustomizer from "./bar-customizer";
import DetailModal from "./detail-modal";

type Props = {
  /** The section this page belongs to. Messages and Photos belong to whichever was visited last. */
  current: Section;
  roles: string[];
  onOpenAccount: () => void;
  onTour: () => void;
  onSignOut: () => void;
};

const ICONS: Record<IconName, React.ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  photos: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>,
  messages: <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H10l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
  menu: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  news: <><path d="M4 5h13a1 1 0 0 1 1 1v13H6a2 2 0 0 1-2-2z" /><path d="M18 9h2v8a2 2 0 0 1-2 2M8 9h6M8 13h6" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>,
  children: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="10" r="2.2" /><path d="M3 20a6 6 0 0 1 12 0M15 20a4 4 0 0 1 6 0" /></>,
  paperwork: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  teach: <><path d="M3 9 12 5l9 4-9 4z" /><path d="M7 11.5V16c0 1.2 2.2 2.5 5 2.5s5-1.3 5-2.5v-4.5" /></>,
  classes: <><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h11" /></>,
  dashboard: <><rect x="4" y="4" width="7" height="8" rx="1.5" /><rect x="13" y="4" width="7" height="5" rx="1.5" /><rect x="13" y="11" width="7" height="9" rx="1.5" /><rect x="4" y="14" width="7" height="6" rx="1.5" /></>,
  families: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5M10 20v-5h4v5" /></>,
  invitations: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="m4 8 8 6 8-6" /></>,
  compliance: <><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" /><path d="m9 12 2.2 2.2L15.5 10" /></>,
  reports: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  integrations: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 5h12l-2 4 2 4H5" /></>,
};

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

/**
 * Bottom navigation for the installed and native apps (hidden by CSS in an
 * ordinary browser tab). What it shows is each person's own choice, per
 * section; the Menu sheet holds the section switcher, account, the tour,
 * the bar editor, and signing out.
 */
export default function AppTabBar({ current, roles, onOpenAccount, onTour, onSignOut }: Props) {
  const unread = useUnreadCount();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prefs, setPrefs] = useState<NavPrefs>(() => (typeof window === "undefined" ? {} : readCachedPrefs()));
  const [userId, setUserId] = useState<string | null>(null);
  // Where we are, read once per page; every destination is a full page load (or a same-page anchor).
  const [path] = useState(() => (typeof window === "undefined" ? "" : window.location.pathname));
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  const [search, setSearch] = useState(() => (typeof window === "undefined" ? "" : window.location.search));

  const crossSection = /^\/family-village\/(messages|photos)(\/|$)/.test(path);
  const wanted: Section = crossSection ? readLastSection() : current;
  const section: Section = wanted === "admin" && !roles.includes("admin") ? "home" : wanted === "teacher" && !roles.includes("teacher") ? "home" : wanted;

  async function loadPrefs() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    setUserId(auth.user.id);
    const { data } = await supabase.from("user_nav_prefs").select("prefs").eq("user_id", auth.user.id).maybeSingle();
    if (data) {
      const fresh = cleanPrefs(data.prefs);
      setPrefs(fresh);
      writeCachedPrefs(fresh);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void loadPrefs(); }, []);

  useEffect(() => { if (!crossSection) writeLastSection(current); }, [crossSection, current]);

  useEffect(() => {
    const onChange = () => { setHash(window.location.hash); setSearch(window.location.search); };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    window.addEventListener("vv-locationchange", onChange);
    return () => { window.removeEventListener("hashchange", onChange); window.removeEventListener("popstate", onChange); window.removeEventListener("vv-locationchange", onChange); };
  }, []);

  // While a field has focus the keyboard needs the room; the bar steps aside (see platform.css).
  useEffect(() => {
    const root = document.documentElement;
    const isField = (el: EventTarget | null) => el instanceof HTMLElement && el.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea, select, [contenteditable=true]");
    const onIn = (event: FocusEvent) => { if (isField(event.target)) root.dataset.kb = "1"; };
    const onOut = () => { delete root.dataset.kb; };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => { document.removeEventListener("focusin", onIn); document.removeEventListener("focusout", onOut); delete root.dataset.kb; };
  }, []);

  async function savePrefs(next: NavPrefs) {
    setPrefs(next);
    writeCachedPrefs(next);
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return "Saved on this device. It could not be saved to your account.";
    const { error } = await supabase.from("user_nav_prefs").upsert({ user_id: userId, prefs: next, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return error ? "Saved on this device. It could not be saved to your account." : "";
  }

  const bar = resolveBar(prefs, section, roles);

  return <>
    <nav className={`app-tabbar${bar.length >= 5 ? " many" : ""}`} aria-label="Main">
      {bar.map((dest) => {
        const active = isActive(dest, path, hash, search);
        const badge = dest.id === "messages" ? unread : 0;
        return <a key={dest.id} className={`app-tab${active ? " active" : ""}`} href={dest.href} aria-current={active ? "page" : undefined}>
          <span className="app-tab-icon"><Icon name={dest.icon} />{badge > 0 && <span className="app-tab-badge">{badge > 99 ? "99+" : badge}</span>}</span>
          <span className="app-tab-label">{dest.label}</span>
        </a>;
      })}
      <button type="button" className="app-tab" onClick={() => setMenuOpen(true)} aria-haspopup="dialog">
        <span className="app-tab-icon"><Icon name="menu" /></span>
        <span className="app-tab-label">Menu</span>
      </button>
    </nav>

    {menuOpen && <DetailModal title="Menu" backLayer={false} onClose={() => setMenuOpen(false)}>
      <ul className="app-menu">
        <li><a href="/family-village/home">Family home</a></li>
        {(["Family", "Everywhere", "Teaching", "Administration"] as const).map((group) => {
          const items = availableDestinations(roles).filter((d) => d.group === group && d.id !== "home");
          if (!items.length) return null;
          return <li key={group} className="app-menu-group">
            <p>{group === "Everywhere" ? "Anywhere in the portal" : group === "Teaching" ? "Teacher" : group === "Administration" ? "Admin" : group}</p>
            <ul>{items.map((d) => <li key={d.id}><a className="app-menu-sub" href={d.href}>{d.label}</a></li>)}</ul>
          </li>;
        })}
        <li><button type="button" onClick={() => { setMenuOpen(false); setEditing(true); }}>Customize bottom bar</button></li>
        <li><button type="button" onClick={() => { setMenuOpen(false); onOpenAccount(); }}>Account &amp; security</button></li>
        <li><button type="button" onClick={() => { setMenuOpen(false); onTour(); }}>Take the tour</button></li>
        <li><button type="button" onClick={onSignOut}>Sign out</button></li>
      </ul>
    </DetailModal>}

    {editing && <DetailModal title="Customize bottom bar" onClose={() => setEditing(false)}>
      <BarCustomizer roles={roles} prefs={prefs} startSection={section} onSave={savePrefs} onClose={() => setEditing(false)} />
    </DetailModal>}
  </>;
}
