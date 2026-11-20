/**
 * Each person's own appearance (issue #140, part 2): an accent from the co-op's allowed palettes, and larger text.
 * Light / Dark / System lives in lib/theme.ts and follows the same rule as these two.
 *
 * Kept per device in localStorage and, when signed in, on the account (user_nav_prefs.prefs.accent and .textSize).
 * The device's own choice wins; a device that has never been set adopts the account's (app/family-village/app-tab-bar.tsx
 * reads the account). COOP_SCRIPT (lib/coop-theme.ts) applies both before the first paint.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PERSONAL_ACCENT_KEY, TEXT_SIZE_KEY, paletteById, type TextSize } from "./coop-theme";
import { applyCoopTheme, coopTheme } from "./coop-settings";
import { nativeFrame } from "./native-frame";

/** "coop" is the co-op's own palette; anything else is a ready-made palette id. */
export type AccentChoice = string;
export const COOP_ACCENT: AccentChoice = "coop";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function storage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function isAccentChoice(value: unknown): value is AccentChoice {
  return value === COOP_ACCENT || Boolean(paletteById(value));
}
export function isTextSize(value: unknown): value is TextSize {
  return value === "normal" || value === "large";
}

/** The choice stored on this device, or null when there is none. */
export function readStoredAccent(store: StorageLike | null = storage()): AccentChoice | null {
  try { const v = store?.getItem(PERSONAL_ACCENT_KEY); return isAccentChoice(v) ? v : null; } catch { return null; }
}
export function readStoredTextSize(store: StorageLike | null = storage()): TextSize | null {
  try { const v = store?.getItem(TEXT_SIZE_KEY); return isTextSize(v) ? v : null; } catch { return null; }
}

/** The device's choice wins; a device never set takes the account's; neither means the default. */
export function chooseSetting<T>(device: T | null, account: unknown, valid: (v: unknown) => v is T, fallback: T): T {
  if (device !== null && valid(device)) return device;
  if (valid(account)) return account;
  return fallback;
}

/** Applies the person's accent now and keeps it on this device. The co-op's settings decide whether it is allowed. */
export function applyPersonalAccent(choice: AccentChoice, options: { persist?: boolean } = {}) {
  if (options.persist) { try { storage()?.setItem(PERSONAL_ACCENT_KEY, choice); } catch { /* the page still shows it */ } }
  applyCoopTheme(coopTheme());
}

/** Larger text: scales every font size and line height (app/appearance.css, --text-scale). */
export function applyTextSize(size: TextSize, options: { persist?: boolean } = {}) {
  if (options.persist) { try { storage()?.setItem(TEXT_SIZE_KEY, size); } catch { /* the page still shows it */ } }
  if (typeof document === "undefined") return;
  if (size === "large") document.documentElement.dataset.textSize = "large";
  else delete document.documentElement.dataset.textSize;
  // The iPhone app's native screens (Messages) take at least one step larger Dynamic Type (a no-op elsewhere).
  nativeFrame()?.post("appearance", { textSize: size });
}

/**
 * Keeps one or both choices on the account, merged into the small per-person record (the tab bar saves it whole,
 * so read and merge first). True when saved; false is not an error to show, the device has it.
 */
export async function savePersonalToAccount(supabase: SupabaseClient, changes: { accent?: AccentChoice; textSize?: TextSize }): Promise<boolean> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return false;
    const { data } = await supabase.from("user_nav_prefs").select("prefs").eq("user_id", userId).maybeSingle();
    const current = data?.prefs && typeof data.prefs === "object" && !Array.isArray(data.prefs) ? (data.prefs as Record<string, unknown>) : {};
    const { error } = await supabase
      .from("user_nav_prefs")
      .upsert({ user_id: userId, prefs: { ...current, ...changes }, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return !error;
  } catch {
    return false;
  }
}
