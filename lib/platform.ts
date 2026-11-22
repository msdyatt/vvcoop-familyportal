/**
 * Which kind of device and shell the page is running in. The same function is
 * inlined into the document head (app/layout.tsx) so the page is styled
 * correctly before it paints; this copy is for code that needs the answer.
 *
 *   platform: "ios" | "android" | "web"
 *   shell:    "native"     inside the iOS/Android app
 *             "standalone" added to a phone's home screen
 *             "browser"    an ordinary tab
 *
 * Platform styling (the tab bar, bottom sheets, system fonts, glass or tonal
 * surfaces) applies only to "native" and "standalone": on the website in a
 * browser the brand design is left alone.
 *
 * The iPhone app is a native frame around the site (docs/native-ios-frame.md).
 * Its web views get `window.VVNative` before any page script runs; then
 * `html[data-frame]` is set as well as the attributes above, and the frame
 * draws the navigation bar and tab bar itself. Android still runs inside
 * Capacitor and has no `data-frame`.
 */
export type Platform = "ios" | "android" | "web";
export type Shell = "native" | "standalone" | "browser";

export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,c=window.Capacitor,f=window.VVNative,ua=navigator.userAgent;
var frame=!!(f&&f.frame);
var native=frame||!!(c&&c.isNativePlatform&&c.isNativePlatform());
var p=frame?(f.platform||'ios'):native&&c.getPlatform?c.getPlatform():(/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))?'ios':/Android/.test(ua)?'android':'web';
var s=native?'native':(matchMedia('(display-mode: standalone)').matches||navigator.standalone===true)?'standalone':'browser';
d.dataset.platform=p;d.dataset.shell=s;if(frame)d.dataset.frame=p;if(s!=='browser'&&p!=='web')d.dataset.app='1';}catch(e){}})();`;

const PLATFORM_FLAGS = ["platform", "shell", "frame", "app"] as const;
/** The `<html>` attributes PLATFORM_SCRIPT sets, for code that watches them (app/platform-sync.tsx). */
export const PLATFORM_ATTRIBUTES = PLATFORM_FLAGS.map((flag) => `data-${flag}`);

/**
 * What PLATFORM_SCRIPT works out, as values for `html.dataset` (absent keys are left unset). The same logic as the
 * script, line for line: the script has to be a string for the head and cannot be run again from here without
 * eval, which the site's Content-Security-Policy does not allow. tests/app-shell.test.mjs checks the two agree.
 */
export function detectPlatformFlags(win: Window = window): Partial<Record<(typeof PLATFORM_FLAGS)[number], string>> {
  const w = win as Window & { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }; VVNative?: { frame?: boolean; platform?: string } };
  const c = w.Capacitor, f = w.VVNative, nav = w.navigator as Navigator & { standalone?: boolean }, ua = nav.userAgent;
  const frame = !!(f && f.frame);
  const native = frame || !!(c && c.isNativePlatform && c.isNativePlatform());
  const p = frame ? (f!.platform || "ios") : native && c!.getPlatform ? c!.getPlatform() : (/iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)) ? "ios" : /Android/.test(ua) ? "android" : "web";
  const s = native ? "native" : (w.matchMedia("(display-mode: standalone)").matches || nav.standalone === true) ? "standalone" : "browser";
  const flags: Partial<Record<(typeof PLATFORM_FLAGS)[number], string>> = { platform: p, shell: s };
  if (frame) flags.frame = p;
  if (s !== "browser" && p !== "web") flags.app = "1";
  return flags;
}

/** Puts the platform attributes on `<html>` where they are missing or wrong. Returns whether anything changed. */
export function restorePlatformFlags(root: HTMLElement = document.documentElement, win: Window = window): boolean {
  let flags;
  try { flags = detectPlatformFlags(win); } catch { return false; }
  let changed = false;
  for (const flag of PLATFORM_FLAGS) {
    const want = flags[flag];
    if (want !== undefined && root.dataset[flag] !== want) { root.dataset[flag] = want; changed = true; }
  }
  return changed;
}
