/**
 * Bridge to the native app shell (mobile/). In an ordinary browser none of this
 * exists and every helper reports "not native", so the web app behaves exactly
 * as before. Inside the iOS or Android app the shell injects `window.Capacitor`
 * and its plugins; we use them through that global rather than importing the
 * plugin packages, so nothing native is bundled into the website.
 */

import { nativeFrame, type NativeFrame } from "./native-frame";

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
  // The iPhone app's native frame (no Capacitor there).
  if (nativeFrame()) return "ios";
  const cap = capacitor();
  if (!cap?.isNativePlatform?.()) return null;
  const platform = cap.getPlatform?.();
  return platform === "ios" || platform === "android" ? platform : null;
}

/**
 * The iPhone frame's push, shaped like the Capacitor Firebase plugin so lib/push.ts has one code path.
 * The frame asks for permission, registers with Apple and returns the Firebase token. Opening the page
 * when a notification is tapped is native (the frame knows the url), so that listener is a no-op here.
 */
function frameMessaging(frame: NativeFrame): FirebaseMessagingPlugin {
  type Receive = { receive: "prompt" | "granted" | "denied" };
  return {
    checkPermissions: () => frame.call<Receive>("push.status"),
    requestPermissions: () => frame.call<Receive>("push.enable").then((r) => ({ receive: r.receive })),
    getToken: () => frame.call<{ token: string }>("push.token"),
    deleteToken: () => frame.call("push.disable").then(() => undefined),
    addListener: ((event: string, handler: (e: { token: string }) => void) => {
      if (event === "tokenReceived") frame.on<{ token: string }>("pushToken", handler);
      return Promise.resolve({ remove: () => undefined });
    }) as FirebaseMessagingPlugin["addListener"],
  };
}

export function messagingPlugin(): FirebaseMessagingPlugin | null {
  const frame = nativeFrame();
  if (frame) return frameMessaging(frame);
  return (capacitor()?.Plugins?.FirebaseMessaging as FirebaseMessagingPlugin | undefined) ?? null;
}

/** The same rule the server applies: a notification can only ever send you to a page on this site. */
export function safeAppPath(path: unknown): string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\")
    ? path
    : "/family-village/home";
}
