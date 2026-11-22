/**
 * The co-op's settings on the page (docs/theming.md, "Co-op theme").
 *
 * One row, public.coop_settings, readable by anyone (the sign-in page shows the name and logo before anyone is
 * signed in). The page keeps the last copy on the device (localStorage COOP_THEME_KEY) so COOP_SCRIPT can dress the
 * next page before it paints; CoopThemeSync (app/coop-theme-sync.tsx) fetches the row once per page load and
 * refreshes that copy. Components read the name and contact through useCoopTheme(); before anything is known they
 * get the defaults, which are the Veritas Village look.
 */
import { useSyncExternalStore } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { COOP_THEME_KEY, DEFAULT_THEME, LOGO_BUCKET, PERSONAL_ACCENT_KEY, THEME_DATASET_KEYS, THEME_VAR_NAMES, activeVariant, coopToday, effectiveAccent, parseTheme, themeDataset, themeFromRow, themeVars, type CoopTheme } from "./coop-theme";
import { nativeFrame } from "./native-frame";

export const LOGO_VARIANT_COLUMNS =
  "id,name,starts_on,ends_on,yearly,override,logo_light_path,logo_dark_path,mark_light_path,mark_dark_path,logo_ratio,updated_at";

export const COOP_SETTINGS_COLUMNS =
  "name,palette_id,accent,heading_font,body_font,header_style,sidebar_style,header_band,sidebar_band,whimsy,logo_light_path,logo_dark_path,mark_light_path,mark_dark_path,logo_ratio,support_email,support_phone,personal_palettes,updated_at";

let current: CoopTheme | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** The copy kept on this device, or null (first visit, private mode, storage blocked, or junk). */
export function readCachedTheme(): CoopTheme | null {
  try {
    const raw = storage()?.getItem(COOP_THEME_KEY);
    return raw ? parseTheme(JSON.parse(raw)) : null;
  } catch { return null; }
}

function readPersonalAccent(): string | null {
  try { return storage()?.getItem(PERSONAL_ACCENT_KEY) ?? null; } catch { return null; }
}

function writeCachedTheme(theme: CoopTheme) {
  try { storage()?.setItem(COOP_THEME_KEY, JSON.stringify(theme)); } catch { /* the page still shows it */ }
}

/** The theme in force on this page. */
export function coopTheme(): CoopTheme {
  if (!current) current = readCachedTheme() ?? DEFAULT_THEME;
  return current;
}

/**
 * Dresses the document in a theme: the custom properties, and the iPhone frame's bars through the bridge. On the
 * document, the person's own palette (lib/personal-appearance.ts) replaces the co-op's when the co-op allows it.
 */
export function applyCoopTheme(theme: CoopTheme, element?: HTMLElement) {
  if (typeof document === "undefined") return;
  const target = element ?? document.documentElement;
  if (!element) theme = { ...theme, accent: effectiveAccent(theme, readPersonalAccent()) };
  const vars = themeVars(theme);
  for (const name of THEME_VAR_NAMES) {
    if (name in vars) target.style.setProperty(name, vars[name]);
    else target.style.removeProperty(name);
  }
  if (!element) {
    // Header and sidebar styles and the small touches are attributes on <html> (app/desktop-nav.css).
    const data = themeDataset(theme);
    for (const key of THEME_DATASET_KEYS) {
      if (key in data) target.dataset[key] = data[key];
      else delete target.dataset[key];
    }
    paintFavicon(theme);
    // The frame colours its own header rule, selected tab and buttons; it keeps them for the next launch.
    nativeFrame()?.post("coopTheme", {
      name: theme.name,
      accent: theme.accent.accent, accentText: theme.accent.accent_text,
      accentOnInk: theme.accent.accent_on_ink, nightFill: theme.accent.night_fill,
    });
  }
}

/**
 * The browser tab's icon: a seasonal variant's compact mark (light) while it is in force, else the bundled icons. Only
 * browsers can change it; a home-screen icon (installed web app, iPhone and Android apps) is fixed when installed.
 */
function paintFavicon(theme: CoopTheme) {
  const mark = activeVariant(theme.seasonal, coopToday(theme.timeZone))?.logos.mark_light ?? null;
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'))) {
    if (!link.dataset.defaultHref) link.dataset.defaultHref = link.getAttribute("href") ?? "";
    const want = mark ?? link.dataset.defaultHref;
    if (link.getAttribute("href") !== want) link.setAttribute("href", want);
  }
}

/** Makes a theme the one in force: applies it, keeps it on the device, and tells components that read it. */
export function setCoopTheme(theme: CoopTheme) {
  const changed = JSON.stringify(theme) !== JSON.stringify(current);
  current = theme;
  applyCoopTheme(theme);
  writeCachedTheme(theme);
  if (changed) for (const listener of listeners) listener();
}

/** The public URL of a file in the brand bucket. */
export function brandFileUrl(supabase: SupabaseClient, path: string): string {
  return supabase.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** The settings row as a theme; null when it could not be read (offline, not set up), so the cached one stays. */
export async function fetchCoopTheme(supabase: SupabaseClient): Promise<CoopTheme | null> {
  try {
    const [{ data, error }, variants] = await Promise.all([
      supabase.from("coop_settings").select(COOP_SETTINGS_COLUMNS).eq("id", "coop").maybeSingle(),
      // Seasonal logos (part 3). If they cannot be read, the co-op's own logos show.
      supabase.from("coop_logo_variants").select(LOGO_VARIANT_COLUMNS).order("updated_at", { ascending: false }),
    ]);
    if (error || !data) return null;
    return themeFromRow(data as Record<string, unknown>, (path) => brandFileUrl(supabase, path), (variants.data ?? []) as Record<string, unknown>[]);
  } catch { return null; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The co-op's theme for a component. The server and the first client render use the defaults (so hydration
 * matches); the device's copy and then the fetched one follow straight after.
 */
export function useCoopTheme(): CoopTheme {
  return useSyncExternalStore(subscribe, coopTheme, () => DEFAULT_THEME);
}

/** Just the name, for labels and sentences. */
export function useCoopName(): string {
  return useCoopTheme().name;
}
