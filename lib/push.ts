import { getSupabaseBrowserClient, functionErrorMessage } from "./supabase";
import { messagingPlugin, nativePlatform } from "./native";

// The phone token this install last registered, so the settings screen can say "on" without asking the server.
const NATIVE_TOKEN_KEY = "vv-native-push-token";
function readNativeToken(): string | null { try { return localStorage.getItem(NATIVE_TOKEN_KEY); } catch { return null; } }
function writeNativeToken(token: string | null) { try { token ? localStorage.setItem(NATIVE_TOKEN_KEY, token) : localStorage.removeItem(NATIVE_TOKEN_KEY); } catch { /* storage unavailable */ } }

/**
 * Browser side of web push. The service worker (public/sw.js) shows the
 * notification; the deliver-push edge function sends it; this file registers
 * the worker, asks permission, and records this device's subscription so the
 * server knows where to send.
 */

export type PushState =
  | "unsupported"       // this browser can't do push at all
  | "needs-install"     // iPhone/iPad: push only works once added to the Home Screen
  | "denied"            // the user blocked notifications in the browser
  | "off"               // possible, not turned on for this device
  | "on";               // subscribed

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ reports itself as a Mac with a touch screen.
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function pushApisPresent(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushApisPresent()) return null;
  return (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
}

export async function getPushState(): Promise<PushState> {
  if (nativePlatform()) {
    const plugin = messagingPlugin();
    if (!plugin) return "unsupported";
    const { receive } = await plugin.checkPermissions();
    if (receive === "denied") return "denied";
    return receive === "granted" && readNativeToken() ? "on" : "off";
  }
  if (!pushApisPresent()) return isIosDevice() && !isInstalledApp() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function urlBase64ToBytes(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Registers this phone's Firebase token with the server (inside the iOS/Android app). */
async function enableNativePush(platform: "ios" | "android"): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = getSupabaseBrowserClient();
  const plugin = messagingPlugin();
  if (!supabase || !plugin) return { ok: false, error: "Notifications are not available right now." };
  const { receive } = await plugin.requestPermissions();
  if (receive !== "granted") return { ok: false, error: "Notifications were not allowed. You can change this in your phone's Settings." };
  const { token } = await plugin.getToken();
  const { error } = await supabase.rpc("register_device_token", { p_token: token, p_platform: platform, p_user_agent: "Veritas Village app" });
  if (error) return { ok: false, error: error.message };
  writeNativeToken(token);
  return { ok: true };
}

/** Re-registers the saved token (Firebase rotates tokens now and then). A no-op unless this install had notifications on. */
export async function refreshNativeToken(token: string): Promise<void> {
  const platform = nativePlatform();
  const supabase = getSupabaseBrowserClient();
  if (!platform || !supabase || !readNativeToken()) return;
  const { error } = await supabase.rpc("register_device_token", { p_token: token, p_platform: platform, p_user_agent: "Veritas Village app" });
  if (!error) writeNativeToken(token);
}

export async function enablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  const native = nativePlatform();
  if (native) return enableNativePush(native);
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { ok: false, error: "Notifications are not available right now." };
  const reg = await registration();
  if (!reg) return { ok: false, error: "This browser does not support notifications." };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, error: "Notifications were not allowed. You can change this in your browser or phone settings." };

  const { data, error } = await supabase.functions.invoke("deliver-push", { body: { mode: "public-key" } });
  const publicKey = (data as { publicKey?: string } | null)?.publicKey;
  if (error || !publicKey) return { ok: false, error: await functionErrorMessage(error, data as { error?: string } | null, "Notifications are not set up yet.") };

  const existing = await reg.pushManager.getSubscription();
  // A subscription made with a different server key can't be reused.
  if (existing) await existing.unsubscribe();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource });

  const { error: saveError } = await supabase.rpc("register_push_subscription", {
    p_endpoint: sub.endpoint,
    p_p256dh: bytesToBase64Url(sub.getKey("p256dh")),
    p_auth: bytesToBase64Url(sub.getKey("auth")),
    p_user_agent: navigator.userAgent.slice(0, 300),
  });
  if (saveError) { await sub.unsubscribe(); return { ok: false, error: saveError.message }; }
  return { ok: true };
}

/** Stops pushes to this device. Safe to call when nothing is subscribed. */
export async function disablePush(): Promise<void> {
  if (nativePlatform()) {
    const token = readNativeToken();
    const supabase = getSupabaseBrowserClient();
    // Server record first, while the session still exists; then Firebase's.
    if (token) await supabase?.rpc("unregister_device_token", { p_token: token });
    await messagingPlugin()?.deleteToken().catch(() => {});
    writeNativeToken(null);
    return;
  }
  if (!pushApisPresent()) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const supabase = getSupabaseBrowserClient();
  // Server record first, while the session still exists; then the browser's.
  await supabase?.rpc("unregister_push_subscription", { p_endpoint: sub.endpoint });
  await sub.unsubscribe();
}

export async function sendTestPush(): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return "Notifications are not available right now.";
  const { data, error } = await supabase.functions.invoke("deliver-push", { body: { mode: "test" } });
  if (error) return functionErrorMessage(error, data as { error?: string } | null, "The test notification could not be sent.");
  const result = data as { sent?: number } | null;
  return result?.sent ? "Test sent — it should arrive in a moment." : "No device is registered for your account yet.";
}
