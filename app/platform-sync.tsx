"use client";

import { useEffect } from "react";
import { PLATFORM_ATTRIBUTES, restorePlatformFlags } from "../lib/platform";

/**
 * Keeps the platform flags on <html> (data-platform, data-shell, data-app, data-frame) that the head script sets
 * before the first paint (lib/platform.ts). If React rebuilds <html> after a hydration error it removes every
 * attribute the head script set; without data-app the installed web app loses its bottom bar (issue #111). ThemeSync
 * and CoopThemeSync guard their own attributes the same way, and the iPhone frame does it natively
 * (docs/native-ios-frame.md). Only puts back what is missing or wrong, so it never fights a deliberate change.
 * Renders nothing.
 */
export default function PlatformSync() {
  useEffect(() => {
    const root = document.documentElement;
    // The rebuild happens in React's commit, before effects run, so check once now as well as on every change.
    restorePlatformFlags(root);
    const guard = new MutationObserver(() => { restorePlatformFlags(root); });
    guard.observe(root, { attributes: true, attributeFilter: PLATFORM_ATTRIBUTES });
    return () => guard.disconnect();
  }, []);
  return null;
}
