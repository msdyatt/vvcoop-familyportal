import { getSupabaseBrowserClient } from "./supabase";

/**
 * A push notification's link carries ?vvn=<notification id>. Opening it counts as seeing the
 * notification, so the email/text fallback stops waiting on it. This tells the server, then
 * removes the marker from the address so a reload or a shared link does not repeat it.
 * Does nothing when the marker is absent or nobody is signed in (the marker is then left in
 * place; it is harmless, and it only works for the notification's own recipient anyway).
 */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function openedNotificationId(search: string): string | null {
  const value = new URLSearchParams(search).get("vvn");
  return value && ID.test(value) ? value : null;
}

export function withoutOpenMarker(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("vvn");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export async function recordOpenFromAddress(): Promise<void> {
  if (typeof window === "undefined") return;
  const id = openedNotificationId(window.location.search);
  if (!id) return;
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  if (!data.session) return;
  const { error } = await supabase.rpc("record_notification_open", { p_notification_id: id });
  if (error) return;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${withoutOpenMarker(window.location.search)}${window.location.hash}`);
}
