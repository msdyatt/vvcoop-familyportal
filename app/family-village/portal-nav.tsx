"use client";

import { useRef, useState } from "react";
import { useOutsideClick } from "../../lib/use-outside-click";

type PortalKey = "home" | "admin" | "teacher";

const LABELS: Record<PortalKey, string> = {
  home: "Family",
  admin: "Admin",
  teacher: "Teacher",
};

const HREFS: Record<PortalKey, string> = {
  home: "/family-village/home",
  admin: "/family-village/admin",
  teacher: "/family-village/teacher",
};

export default function PortalNav({ current, roles }: { current: PortalKey; roles: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const available: PortalKey[] = ["home", ...(roles.includes("teacher") ? (["teacher"] as const) : []), ...(roles.includes("admin") ? (["admin"] as const) : [])];

  useOutsideClick(rootRef, () => setOpen(false));

  if (available.length <= 1) return null;

  return (
    <div className="portal-nav" ref={rootRef}>
      <button type="button" className="portal-nav-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {LABELS[current]} workspace <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="portal-nav-menu" role="menu">
          {available.map((key) => (
            <a key={key} href={HREFS[key]} role="menuitem" className={key === current ? "active" : ""} onClick={() => setOpen(false)}>
              {LABELS[key]} {key === current && <span>· current</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
