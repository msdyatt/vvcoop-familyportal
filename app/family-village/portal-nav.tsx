"use client";

import { useRef, useState } from "react";
import { useOutsideClick } from "../../lib/use-outside-click";
import PortalMenuItems from "./portal-menu-items";

/**
 * The header's Menu in a browser (the apps hide it and use the bottom bar and its Menu sheet). Family and
 * Teaching are one flat list; Admin, for admins only, is its own marked block. `roles` is what the person may
 * use, Teaching included when they teach this year.
 */
export default function PortalNav({ roles }: { roles: string[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useOutsideClick(rootRef, () => setOpen(false));

  return (
    <div className="portal-nav" ref={rootRef}>
      <button type="button" className="portal-nav-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        Menu <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="portal-nav-menu" role="menu">
          <ul className="portal-nav-list"><PortalMenuItems roles={roles} onNavigate={() => setOpen(false)} /></ul>
        </div>
      )}
    </div>
  );
}
