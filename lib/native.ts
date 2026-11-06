/**
 * Bridge to the native app shell (mobile/). In an ordinary browser none of this
 * exists and every helper reports "not native", so the web app behaves exactly
 * as before. Inside the iOS or Android app the shell injects `window.Capacitor`
 * and its plugins; we use them through that global rather than importing the
 * plugin packages, so nothing native is bundled into the website.
 */

type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
};

export type FirebaseMessagingPlugin = {
  checkPermissions(): Promise<{ receive: "prompt" | "prompt-with-rationale" | "granted" | "denied" }>;
  requestPermissions(): Promise<{ receive: "prompt" | "prompt-with-rationale" | "granted" | "denied" }>;
  getToken(): Promise<{ token: string }>;
  deleteToken(): Promise<void>;
  addListener(event: "tokenReceived", handler: (event: { token: string }) => void): Promise<unknown>;
  addListener(event: "notificationActionPerformed", handler: (event: { notification: { data?: Record<string, unknown> } }) => void): Promise<unknown>;
};

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

/** "ios" or "android" inside the app; null in any browser. */
export function nativePlatform(): "ios" | "android" | null {
  const cap = capacitor();
  if (!cap?.isNativePlatform?.()) return null;
  const platform = cap.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

export function messagingPlugin(): FirebaseMessagingPlugin | null {
  return (capacitor()?.Plugins?.FirebaseMessaging as FirebaseMessagingPlugin | undefined) ?? null;
}

/** The same rule the server applies: a notification can only ever send you to a page on this site. */
export function safeAppPath(path: unknown): string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
    ? path
    : "/family-village/home";
}
