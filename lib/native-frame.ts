/**
 * The page's side of the iPhone app's native frame (docs/native-ios-frame.md).
 *
 * The frame injects `window.VVNative` before any page script runs. In a
 * browser, the home-screen web app and the Android app it does not exist, so
 * `nativeFrame()` is null and every caller does nothing.
 */
import {
  availableDestinations, resolveBar, SECTION_LABELS, type Destination, type NavPrefs, type Section,
} from "./nav-prefs";

export type NativeFrame = {
  frame: true;
  platform: string;
  version: number;
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

type FrameDestination = { id: string; label: string; href: string; icon: string; section?: Section };

const toFrame = (d: Destination, section?: Section): FrameDestination => ({ id: d.id, label: d.label, href: d.href, icon: d.icon, ...(section ? { section } : {}) });

const SECTION_HOME: Record<Section, string> = { home: "/family-village/home", teacher: "/family-village/teacher", admin: "/family-village/admin" };

/**
 * Everything the frame's tab bar and Menu sheet need, worked out with the same
 * functions the web bar uses (resolveBar and friends) so the person's own
 * choices, per section, are honoured and there is one definition of them.
 */
export function buildFrameState(input: { prefs: NavPrefs; roles: string[]; section: Section; unread: number }) {
  const { prefs, roles, section, unread } = input;
  const sections: Section[] = ["home", ...(roles.includes("teacher") ? (["teacher"] as const) : []), ...(roles.includes("admin") ? (["admin"] as const) : [])];
  const pool = availableDestinations(roles);
  const sectionOf = (d: Destination): Section | undefined => (d.group === "Teaching" ? "teacher" : d.group === "Administration" ? "admin" : undefined);
  return {
    signedIn: true,
    section,
    unread,
    sections: sections.map((id) => ({
      id,
      label: SECTION_LABELS[id],
      home: SECTION_HOME[id],
      bar: resolveBar(prefs, id, roles).map((d) => toFrame(d)),
    })),
    menu: (["Family", "Everywhere", "Teaching", "Administration"] as const)
      .map((group) => ({
        title: group === "Everywhere" ? "Anywhere in the portal" : group === "Teaching" ? "Teacher" : group === "Administration" ? "Admin" : group,
        items: pool.filter((d) => d.group === group).map((d) => toFrame(d, sectionOf(d))),
      }))
      .filter((g) => g.items.length > 0),
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
