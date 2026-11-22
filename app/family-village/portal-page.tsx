"use client";

import { useContext, useLayoutEffect } from "react";
import { AppShell } from "./app-header";
import { PortalFrameContext } from "./portal-frame";
import type { ChromeHeader, ChromePage } from "../../lib/portal-chrome";
import type { PortalKey } from "../../lib/nav-prefs";

type Props = {
  /** The class the page's <main> carries ("workspace-preview messages-page", "portal-state"...). */
  className: string;
  children?: React.ReactNode;
  /** Give a title to show the shared header; leave it out for a screen without one (a sign-in prompt). */
  title?: string;
  subtitle?: string;
  current?: PortalKey;
  roles?: string[];
};

/**
 * A page of the signed-in portal. Inside the portal frame (app/family-village/layout.tsx) it tells the frame its
 * header and <main> class and draws only its own content, so the header, sidebar and bell stay mounted from page
 * to page. Anywhere else it draws the whole page itself.
 */
export default function PortalPage({ className, children, title, subtitle, current = "home", roles = [] }: Props) {
  const register = useContext(PortalFrameContext);
  const header: ChromeHeader | null = title ? { current, roles, title, ...(subtitle ? { subtitle } : {}) } : null;
  // A string, so a new roles array with the same names does not register again.
  const entry = JSON.stringify({ className, header } satisfies ChromePage);
  useLayoutEffect(() => register?.(JSON.parse(entry) as ChromePage), [register, entry]);

  if (!register) return <main className={className}>{header && <AppShell {...header} />}{children}</main>;
  return <>{children}</>;
}
