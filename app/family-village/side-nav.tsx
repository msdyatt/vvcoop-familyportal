"use client";

import { useEffect, useRef, useState } from "react";
import CoopLogo from "../coop-logo";
import { useUnreadCount } from "./messages/messages-link";
import { useCoopTheme } from "../../lib/coop-settings";
import {
  ADMIN_GROUPS, ADMIN_PATH, ADMIN_TAB_EVENT, PORTAL_PRIMARY, PORTAL_SECONDARY,
  DRAWER_EVENT, SIDENAV_KEY, activePortalItem, adminGroupOf, adminHref, adminTabFrom, dayPartOf, greeting, seasonOf,
  type DayPart, type NavIcon, type Season, type SideItem,
} from "../../lib/desktop-nav";
import type { PortalKey } from "../../lib/nav-prefs";

/**
 * The desktop sidebar (lib/desktop-nav.ts says what is in it). Hidden by CSS on phones and in the installed apps,
 * which keep their bottom bar. The small pleasures live here too: a greeting for the time of day, an ink diamond
 * that slides from the place you were to the place you are, a quill underline under the current page, and a little
 * engraved village at the foot whose season blows through when the page opens (and again when you tap it).
 */

const PATHS: Record<NavIcon, React.ReactNode> = {
  today: <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />,
  messages: <path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6l-5 4v-4H7a3 3 0 0 1-3-3z" />,
  calendar: <path d="M6.5 5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM8 3v4M16 3v4M3.5 10h17" />,
  classes: <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21a2 2 0 0 1 2-2h13" />,
  family: <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14.5 18.5a4 4 0 0 1 6.5-2.8M9 5.5a3 3 0 1 1 0 6 3 3 0 1 1 0-6M17 7.5a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 1 1 0-4.8" />,
  photos: <path d="M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM4 17l5-4 4 3 3-2 4 3M9 9.5h.01" />,
  news: <path d="M5 4h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2zM18 9h2v8a2 2 0 0 1-2 2M8 8h6M8 12h6M8 15.5h4" />,
  admin: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />,
  back: <path d="M15 5l-7 7 7 7" />,
  overview: <path d="M4 4h7v8H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 14h7v6H4z" />,
  people: <path d="M3.5 19a5.5 5.5 0 0 1 11 0M14.5 18.5a4 4 0 0 1 6.5-2.8M9 5.5a3 3 0 1 1 0 6 3 3 0 1 1 0-6M17 7.5a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 1 1 0-4.8" />,
  comms: <path d="M4 6h16v12H4zM4 6l8 7 8-7" />,
  money: <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h3" />,
  records: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  settings: <path d="M12 9a3 3 0 1 1 0 6 3 3 0 1 1 0-6M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />,
};

function NavGlyph({ name }: { name: NavIcon }) {
  return <svg className="side-nav-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}

/** A tiny engraving for the time of day: a rising sun, a high sun, a lantern, a crescent moon. */
function DayGlyph({ part }: { part: DayPart }) {
  return <svg className="side-nav-daypart" viewBox="0 0 28 28" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {part === "morning" && <><path d="M3 20h22" /><path d="M8 20a6 6 0 0 1 12 0" /><path d="M14 8v3M7 11l2 2M21 11l-2 2M4 15.5h2.5M21.5 15.5H24" /><path d="M10 23h8" strokeWidth=".7" /></>}
    {part === "afternoon" && <><circle cx="14" cy="14" r="5" /><path d="M14 3v3M14 22v3M3 14h3M22 14h3M6.2 6.2l2.1 2.1M19.7 19.7l2.1 2.1M21.8 6.2l-2.1 2.1M8.3 19.7l-2.1 2.1" /><path d="M11.5 12.5l2-1.5M12 15.5l3-2.2" strokeWidth=".6" /></>}
    {part === "evening" && <><path d="M14 2.5v3M10 5.5h8l-1 3h-6z" /><path d="M10.5 8.5h7v11h-7z" /><path d="M9 19.5h10l-1 3h-8z" /><path d="M14 11.5c-1.6 1.8-1.6 3.6 0 5 1.6-1.4 1.6-3.2 0-5z" /><path d="M12 9v10M16 9v10" strokeWidth=".5" /></>}
    {part === "night" && <><path d="M18 4a9 9 0 1 0 6 13A7.5 7.5 0 0 1 18 4z" /><path d="M7 6l.8 1.6L9.4 8l-1.6.8L7 10.4l-.8-1.6L4.6 8l1.6-.4z" strokeWidth=".8" /><path d="M14 9l2 1M13 12l3 1.2M12.5 15.5l3.5.8" strokeWidth=".5" /></>}
  </svg>;
}

/** One falling thing per season, drawn in the same single ink as the village. */
function SeasonBit({ season }: { season: Season }) {
  if (season === "winter") return <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 1v10M1.7 3.5l8.6 5M1.7 8.5l8.6-5M4.6 1.8L6 3.2l1.4-1.4M4.6 10.2L6 8.8l1.4 1.4" fill="none" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" /></svg>;
  if (season === "spring") return <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M6 1.5c2 1.5 2.5 4 0 9-2.5-5-2-7.5 0-9z" fill="currentColor" opacity=".55" /><path d="M6 3v6" fill="none" stroke="currentColor" strokeWidth=".6" /></svg>;
  if (season === "summer") return <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true"><circle cx="6" cy="6" r="2" fill="currentColor" /><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth=".6" opacity=".6" /></svg>;
  return <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M7 1c1.2 1.4 3.6 1 4.4 3-1.4.6-.8 2.2.4 3-1.6 1-1.4 2.6-.2 3.6-2 .4-3.4 1-4.6 2.4-1.2-1.4-2.6-2-4.6-2.4 1.2-1 1.4-2.6-.2-3.6 1.2-.8 1.8-2.4.4-3C3.4 2 5.8 2.4 7 1z" fill="currentColor" opacity=".5" stroke="currentColor" strokeWidth=".6" strokeLinejoin="round" /><path d="M7 3v10" stroke="currentColor" strokeWidth=".6" /></svg>;
}

/** The engraved village at the foot of the sidebar, with the season blowing through it. */
function Village({ season }: { season: Season | null }) {
  const [round, setRound] = useState(0);
  return <button type="button" className={`side-nav-village season-${season ?? "unknown"}`} onClick={() => setRound((n) => n + 1)}
    aria-label={season ? `The village in ${season}. Play the season again` : "The village"}>
    {season && <span className="side-nav-weather" key={round} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((n) => <span key={n} className={`side-nav-bit bit-${n}`}><SeasonBit season={season} /></span>)}
    </span>}
    <svg viewBox="0 0 260 64" width="208" height="52" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 60h256" />
      <path d="M14 60V38l14-11 14 11v22M10 41l18-15 18 15M24 60v-9h8v9M33 31v-6h4v9" />
      <path className="side-nav-smoke" d="M35 22c-2-3 2-4 0-7s2-4 0-7" strokeWidth=".7" />
      <path d="M56 60V46M56 46c-7 0-8-9-3-12-2-6 5-9 8-5 5-2 8 4 5 8 4 4 0 10-5 9" />
      <path d="M76 60V34l20-14 20 14v26M72 37l24-17 24 17M90 60v-10h12v10M96 20v-8M93 12h6v4h-6zM82 40h6v6h-6zM104 40h6v6h-6z" />
      {season === "winter" && <circle cx="96" cy="31" r="3.2" strokeWidth=".9" />}
      <path d="M134 60V30h40v30M130 30h48l-24-12zM140 36v18M148 36v18M160 36v18M168 36v18M150 60v-6h8v6" />
      <path d="M190 60V40M240 60V40M186 40h58l-6-12h-46zM186 40c0 3 3 5 6 5s6-2 6-5c0 3 3 5 6 5s6-2 6-5c0 3 3 5 6 5s6-2 6-5c0 3 3 5 6 5s6-2 6-5c0 3 3 5 6 5" />
      <path d="M16 44l4-3M16 50l4-3M16 56l4-3M78 44l4-3M78 50l4-3M78 56l4-3M136 40l3-2M136 46l3-2M136 52l3-2" strokeWidth=".5" />
      <path d="M250 60V50M250 50c-4 0-5-6-1-8 0-4 5-4 5 0 3 2 1 8-4 8" strokeWidth=".8" />
    </svg>
  </button>;
}

const DIVIDER = <svg className="side-nav-rule" viewBox="0 0 140 14" width="140" height="14" aria-hidden="true"><path d="M0 7h60M80 7h60" stroke="currentColor" strokeWidth="1" /><path d="M70 2.5l4.5 4.5-4.5 4.5-4.5-4.5z" fill="currentColor" /></svg>;

const QUILL_LINE = <svg className="side-nav-quill" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><path d="M2 5c18-3 36 1 56-1.5S88 4 98 2.5" pathLength="100" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;

const LAST_KEY = "vv-sidenav-last";

function readLocation() {
  return { path: window.location.pathname, search: window.location.search };
}

export default function SideNav({ current, roles, name }: { current: PortalKey; roles: string[]; name: string }) {
  const admin = current === "admin";
  const unread = useUnreadCount();
  // Location, clock and the tucked-away choice are read after the first paint, so the server and the browser
  // render the same thing first. The page's width does not jump: SIDENAV_SCRIPT already marked <html> before paint.
  const [where, setWhere] = useState({ path: "", search: "" });
  const [boot, setBoot] = useState<{ now: Date; collapsed: boolean } | null>(null);
  const [choice, setChoice] = useState<boolean | null>(null);
  const collapsed = choice ?? boot?.collapsed ?? false;
  const now = boot?.now ?? null;
  // On a narrow screen in a browser the sidebar is a drawer, opened from the header's Menu button.
  const [drawer, setDrawer] = useState(false);
  const shell = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const open = () => { opener.current = document.activeElement as HTMLElement | null; setDrawer(true); };
    window.addEventListener(DRAWER_EVENT, open);
    return () => window.removeEventListener(DRAWER_EVENT, open);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (!drawer) { delete root.dataset.drawer; return; }
    root.dataset.drawer = "open";
    const frame = window.requestAnimationFrame(() => shell.current?.querySelector<HTMLElement>(".side-nav-close")?.focus());
    // Closes on Escape, and keeps Tab inside the drawer while it is open.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setDrawer(false); opener.current?.focus(); return; }
      if (event.key !== "Tab" || !shell.current) return;
      const stops = [...shell.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")].filter((el) => el.offsetParent !== null);
      if (!stops.length) return;
      const first = stops[0], last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("keydown", onKey); delete root.dataset.drawer; };
  }, [drawer]);

  function close() {
    setDrawer(false);
    opener.current?.focus();
  }

  useEffect(() => {
    const sync = () => setWhere(readLocation());
    sync();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only values, read once after hydration
    setBoot({ now: new Date(), collapsed: document.documentElement.dataset.sidenav === "collapsed" });
    window.addEventListener("popstate", sync);
    window.addEventListener("vv-locationchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("vv-locationchange", sync); };
  }, []);

  function toggle() {
    const next = !collapsed;
    setChoice(next);
    document.documentElement.dataset.sidenav = next ? "collapsed" : "open";
    try { window.localStorage.setItem(SIDENAV_KEY, next ? "collapsed" : "open"); } catch { /* private mode */ }
  }

  const adminTab = adminTabFrom(where.search);
  const items: (SideItem & { hint?: string; tab?: string })[] = admin
    ? ADMIN_GROUPS.map((group) => ({ id: group.id, label: group.label, hint: group.hint, href: adminHref(group.tabs[0].id), icon: group.icon, tab: group.tabs[0].id }))
    : PORTAL_PRIMARY;
  // Nothing is marked until the address has been read (just after the first paint).
  const activeId = !where.path ? null : admin ? adminGroupOf(adminTab).id : activePortalItem(where.path);
  const activeIndex = items.findIndex((item) => item.id === activeId);

  // The ink diamond starts where you last were and slides to where you are now.
  const [marker, setMarker] = useState(-1);
  useEffect(() => {
    if (activeIndex < 0) return;
    const key = `${LAST_KEY}-${admin ? "admin" : "portal"}`;
    let last: string | null = null;
    try { last = window.sessionStorage.getItem(key); window.sessionStorage.setItem(key, String(activeIndex)); } catch { /* private mode */ }
    const start = last === null ? activeIndex : Number(last);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- placed first, then moved, so the slide shows
    setMarker(Number.isFinite(start) && start >= 0 && start < items.length ? start : activeIndex);
    let second = 0;
    const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(() => setMarker(activeIndex)); });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); };
  }, [activeIndex, admin, items.length]);

  function openAdminTab(event: React.MouseEvent, tab: string) {
    // Already in the Admin workspace: switch in place, no reload.
    if (!window.location.pathname.startsWith(ADMIN_PATH)) return;
    event.preventDefault();
    setDrawer(false);
    window.dispatchEvent(new CustomEvent(ADMIN_TAB_EVENT, { detail: adminGroupOf(adminTab).tabs.some((row) => row.id === tab) ? adminTab : tab }));
  }

  // The co-op chooses the season (Admin > Appearance): the calendar's, a fixed one, or none. Unknown until the clock
  // is read, so the weather never starts in the wrong season.
  const chosen = useCoopTheme().whimsy.season;
  const season = chosen === "none" ? null : chosen !== "auto" ? chosen : now ? seasonOf(now) : null;
  const firstName = name.split(/\s+/)[0] ?? "";

  return <div ref={shell} className="side-nav-shell" {...(drawer ? { role: "dialog", "aria-modal": true, "aria-label": "Menu" } : {})}>
    {drawer && <button type="button" className="side-nav-scrim" tabIndex={-1} aria-label="Close the menu" onClick={close} />}
    <nav className={`side-nav${admin ? " side-nav-admin" : ""}`} aria-label={admin ? "Admin" : "Main"}>
    <div className="side-nav-top">
      <a className="side-nav-brand" href={admin ? ADMIN_PATH : "/family-village/home"} aria-label={admin ? "Admin overview" : "Today"}>
        {/* Both versions; the stylesheet shows the one that suits the sidebar's style (a dark band needs the light logo). */}
        <CoopLogo className="side-nav-lockup sn-day" />
        <CoopLogo className="side-nav-lockup sn-night" tone="on-dark" decorative />
        <CoopLogo kind="mark" className="side-nav-mark sn-day" decorative />
        <CoopLogo kind="mark" className="side-nav-mark sn-night" tone="on-dark" decorative />
      </a>
      {admin && <span className="side-nav-admin-chip">Admin</span>}
      <button type="button" className="side-nav-close" onClick={close} aria-label="Close the menu">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>

    <p className="side-nav-hello" aria-live="off">
      {now && <><DayGlyph part={dayPartOf(now)} /><span>{greeting(dayPartOf(now), firstName)}</span></>}
    </p>

    {admin && <a className="side-nav-back" href="/family-village/home"><NavGlyph name="back" /><span>Back to the portal</span></a>}

    <ul className="side-nav-list" style={{ "--marker": marker } as React.CSSProperties}>
      {activeIndex >= 0 && marker >= 0 && <li className="side-nav-marker" aria-hidden="true" />}
      {items.map((item) => {
        const active = item.id === activeId;
        const badge = !admin && item.id === "messages" ? unread : 0;
        return <li key={item.id}>
          <a className={`side-nav-item${active ? " active" : ""}`} href={item.href} aria-current={active ? "page" : undefined}
            onClick={item.tab ? (event) => openAdminTab(event, item.tab!) : undefined}>
            <NavGlyph name={item.icon} />
            <span className="side-nav-label">
              <span className="side-nav-text">{item.label}{active && QUILL_LINE}</span>
              {item.hint && <small>{item.hint}</small>}
            </span>
            {badge > 0 && <span className="side-nav-badge" aria-label={`${badge} unread`}>{badge > 99 ? "99+" : badge}</span>}
          </a>
        </li>;
      })}
    </ul>

    {!admin && <>
      {DIVIDER}
      <ul className="side-nav-list secondary">
        {PORTAL_SECONDARY.map((item) => {
          const active = activePortalItem(where.path) === item.id;
          return <li key={item.id}><a className={`side-nav-item quiet${active ? " active" : ""}`} href={item.href} aria-current={active ? "page" : undefined}>
            <NavGlyph name={item.icon} /><span className="side-nav-label"><span className="side-nav-text">{item.label}{active && QUILL_LINE}</span></span>
          </a></li>;
        })}
      </ul>
    </>}

    <div className="side-nav-foot">
      {!admin && roles.includes("admin") && <a className="side-nav-item side-nav-to-admin" href={ADMIN_PATH}>
        <NavGlyph name="admin" /><span className="side-nav-label"><span className="side-nav-text">Admin</span></span>
      </a>}
      <Village season={season} />
      <button type="button" className="side-nav-collapse" onClick={toggle} aria-expanded={!collapsed}
        aria-label={collapsed ? "Bring the sidebar back" : "Tuck the sidebar away"}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {collapsed ? <path d="M9 6l6 6-6 6M4 4v16" /> : <path d="M15 6l-6 6 6 6M20 4v16" />}
        </svg>
        <span>{collapsed ? "" : "Tuck away"}</span>
      </button>
    </div>
  </nav>
  </div>;
}
