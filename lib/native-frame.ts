/**
 * The page's side of the iPhone app's native frame (docs/native-ios-frame.md).
 *
 * The frame injects `window.VVNative` before any page script runs. In a
 * browser, the home-screen web app and the Android app it does not exist, so
 * `nativeFrame()` is null and every caller does nothing.
 */
import { availableDestinations, resolveBar, type Destination, type NavPrefs } from "./nav-prefs";

export type NativeFrame = {
  frame: true;
  platform: string;
  version: number;
  /** What this build of the frame can do, e.g. "pay.sheet". Older builds lack the entry. */
  capabilities?: string[];
  /** Fire and forget. */
  post(type: string, payload?: Record<string, unknown>): void;
  /** Ask the frame something and wait for its answer. */
  call<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T>;
  /** Listen for something the frame tells the page; returns the function that stops listening. */
  on<T = Record<string, unknown>>(type: string, handler: (payload: T) => void): () => void;
};

export function nativeFrame(): NativeFrame | null {
  if (typeof window === "undefined") return null;
  const frame = (window as unknown as { VVNative?: NativeFrame }).VVNative;
  return frame?.frame ? frame : null;
}

type FrameDestination = { id: string; label: string; href: string; icon: string };

const toFrame = (d: Destination): FrameDestination => ({ id: d.id, label: d.label, href: d.href, icon: d.icon });

/**
 * Everything the frame's tab bar and Menu sheet need, worked out with the same functions the web bar uses
 * (resolveBar and friends), so the person's own choices are honoured and there is one definition of them.
 *
 * The frame has ONE bar for the whole app: the person's main bar, which carries Family and Teaching items
 * together. Admin pages are on it if they put them there, and are otherwise a tap away in the Menu, which is
 * one flat list (an untitled group) with Admin set apart in its own titled group after it.
 *
 * `roles` is what the person may use: their roles plus "teacher" when they teach this year (withTeaching).
 * The message keeps the shape it has always had (bar, and menu groups with a title and items), so a frame
 * build from before the portals were joined still reads it; it shows the untitled group without a heading.
 */
export function buildFrameState(input: { prefs: NavPrefs; roles: string[]; unread: number }) {
  const { prefs, roles, unread } = input;
  const pool = availableDestinations(roles);
  return {
    signedIn: true,
    unread,
    home: "/family-village/home",
    bar: resolveBar(prefs, "home", roles).map(toFrame),
    menu: [
      { title: "", items: pool.filter((d) => d.area === "portal").map(toFrame) },
      { title: "Admin", items: pool.filter((d) => d.area === "admin").map(toFrame) },
    ].filter((g) => g.items.length > 0),
  };
}

export type HapticStyle = "light" | "medium" | "heavy" | "success" | "warning" | "error" | "selection";

/** A small tap on the phone. Does nothing outside the frame. */
export function haptic(style: HapticStyle = "selection") {
  nativeFrame()?.post("haptic", { style });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Hands a file to the phone's own share sheet (Save to Files, Print, AirDrop, Mail...). Resolves true once the
 * sheet has been shown and closed, false if the frame is not there; rejects if the frame could not present it.
 */
export async function shareBlob(blob: Blob, filename: string): Promise<boolean> {
  const frame = nativeFrame();
  if (!frame) return false;
  await frame.call("share", { filename, mime: blob.type || "application/octet-stream", base64: await toBase64(blob) });
  return true;
}
