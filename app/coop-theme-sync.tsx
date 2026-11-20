"use client";

import { useEffect } from "react";
import { COOP_THEME_KEY } from "../lib/coop-theme";
import { applyCoopTheme, coopTheme, fetchCoopTheme, readCachedTheme, setCoopTheme } from "../lib/coop-settings";
import { getSupabaseBrowserClient } from "../lib/supabase";

/**
 * Keeps the co-op's look in step after the first paint (COOP_SCRIPT dresses the page before it, from the copy on
 * this device): fetches the settings once per page load and refreshes that copy, follows a change saved in another
 * tab, and puts the custom properties back if React rebuilds <html> after a hydration error. Renders nothing.
 */
export default function CoopThemeSync() {
  useEffect(() => {
    applyCoopTheme(coopTheme());
    let live = true;
    const supabase = getSupabaseBrowserClient();
    if (supabase) void fetchCoopTheme(supabase).then((theme) => { if (live && theme) setCoopTheme(theme); });
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COOP_THEME_KEY) return;
      const theme = readCachedTheme();
      if (theme) setCoopTheme(theme);
    };
    const root = document.documentElement;
    const guard = new MutationObserver(() => { if (!root.style.getPropertyValue("--terracotta")) applyCoopTheme(coopTheme()); });
    guard.observe(root, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("storage", onStorage);
    return () => { live = false; guard.disconnect(); window.removeEventListener("storage", onStorage); };
  }, []);
  return null;
}
