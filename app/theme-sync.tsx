"use client";

import { useEffect } from "react";
import { applyTheme, currentChoice, parseChoice, THEME_STORAGE_KEY } from "../lib/theme";

/**
 * Keeps the theme in step after the first paint (lib/theme.ts sets it before): follows the device's light/dark
 * setting while the choice is System, follows a change made in another tab, and tells the iPhone app's native
 * frame which theme this page is in (every page load, so a fresh launch recolours the native bars).
 * Renders nothing.
 */
export default function ThemeSync() {
  useEffect(() => {
    applyTheme(currentChoice());
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => { if (currentChoice() === "system") applyTheme("system"); };
    const onStorage = (event: StorageEvent) => { if (event.key === THEME_STORAGE_KEY) applyTheme(parseChoice(event.newValue)); };
    // If React rebuilds <html> after a hydration error it takes the attributes the head script set (the iPhone frame
    // guards its own flags the same way, docs/native-ios-frame.md), so put the theme back whenever it goes missing.
    const guard = new MutationObserver(() => { if (!document.documentElement.dataset.theme) applyTheme(currentChoice()); });
    guard.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    query.addEventListener("change", onSystem);
    window.addEventListener("storage", onStorage);
    return () => { guard.disconnect(); query.removeEventListener("change", onSystem); window.removeEventListener("storage", onStorage); };
  }, []);
  return null;
}
