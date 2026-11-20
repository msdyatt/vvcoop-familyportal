"use client";

import { useEffect, useState } from "react";
import { ADMIN_PATH, ADMIN_TAB_EVENT, adminGroupOf, adminHref, adminTabFrom, areaFor } from "../../lib/desktop-nav";
import type { PortalKey } from "../../lib/nav-prefs";

/**
 * The tab strip under the header on a wide screen, for places with more than one page: Family (Children,
 * Documents and forms, Dues), Classes for anyone who teaches, and each Admin group. Desktop only (CSS); phones keep
 * the bottom bar and Menu. The pages are links, so the strip is a <nav> with aria-current, not a tablist.
 */
export default function AreaTabs({ current, roles }: { current: PortalKey; roles: string[] }) {
  const [where, setWhere] = useState({ path: "", search: "" });

  useEffect(() => {
    const sync = () => setWhere({ path: window.location.pathname, search: window.location.search });
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener("vv-locationchange", sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener("vv-locationchange", sync); };
  }, []);

  if (!where.path) return null;

  if (current === "admin") {
    const active = adminTabFrom(where.search);
    const group = adminGroupOf(active);
    if (group.tabs.length < 2) return null;
    return <nav className="area-tabs area-tabs-admin" aria-label={group.label}>
      {group.tabs.map((tab) => <a key={tab.id} href={adminHref(tab.id)} aria-current={tab.id === active ? "page" : undefined}
        onClick={(event) => {
          if (!window.location.pathname.startsWith(ADMIN_PATH)) return;
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(ADMIN_TAB_EVENT, { detail: tab.id }));
        }}>{tab.label}</a>)}
    </nav>;
  }

  const area = areaFor(where.path, roles.includes("teacher"));
  if (!area) return null;
  return <nav className="area-tabs" aria-label={area.label}>
    {area.tabs.map((tab) => <a key={tab.id} href={tab.href} aria-current={tab.id === area.active ? "page" : undefined}>{tab.label}</a>)}
  </nav>;
}
