/**
 * Keeps the Light/Dark/System choice on the person's account, in the same small per-person record that holds
 * their bar choices (user_nav_prefs.prefs, a jsonb object), so another phone can start from it and no new table
 * is needed. The record is read and merged first, because the tab bar saves it whole and must not lose either part.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThemeChoice } from "./theme";

/** True when saved. A false is not an error to show: the choice is already kept on this device. */
export async function saveThemeToAccount(supabase: SupabaseClient, choice: ThemeChoice): Promise<boolean> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId) return false;
    const { data } = await supabase.from("user_nav_prefs").select("prefs").eq("user_id", userId).maybeSingle();
    const current = data?.prefs && typeof data.prefs === "object" && !Array.isArray(data.prefs) ? (data.prefs as Record<string, unknown>) : {};
    const { error } = await supabase
      .from("user_nav_prefs")
      .upsert({ user_id: userId, prefs: { ...current, theme: choice }, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return !error;
  } catch {
    return false;
  }
}
