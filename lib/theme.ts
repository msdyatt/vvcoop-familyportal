/**
 * Light, Dark or System (docs/theming.md).
 *
 * The person's choice is kept per device in localStorage and, when they are signed in, on their account
 * (user_nav_prefs.prefs.theme, see lib/theme-account.ts). The device's own choice wins: a phone that has never
 * been set adopts the account's choice, and a phone that has been set keeps it.
 *
 * "system" follows the device's setting live. The page carries the answer as <html data-theme="light|dark">
 * (always one of the two, never "system"), and the choice itself as data-theme-choice. THEME_SCRIPT sets both
 * in the document head before the first paint, so there is no flash of the wrong theme. The same decisions are
 * made by the functions below for everything that happens after load; tests/theme.test.mjs runs the script and
 * the functions side by side.
 */
import { nativeFrame } from "./native-frame";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "vv-theme";

export const THEME_CHOICES: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Match this device" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Easier on the eyes at night" },
];

/**
 * The colour of the browser's address bar / the installed app's status strip, per theme. Light keeps the navy
 * the app has always had; dark is the dark theme's --ink-surface (app/globals.css). An installed web app's
 * manifest cannot change with the theme, so its splash stays navy, which suits both.
 */
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#0b2a3d", dark: "#0d3a57" };

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

/** Whatever was stored (or nothing, or garbage) as a choice; the default is to follow the device. */
export function parseChoice(value: unknown): ThemeChoice {
  return isThemeChoice(value) ? value : "system";
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "dark") return "dark";
  if (choice === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

/**
 * Which choice to use when the device and the account may disagree. A choice made on this device wins; a device
 * that has never been set adopts the account's; neither means follow the device.
 */
export function chooseTheme(device: unknown, account: unknown): ThemeChoice {
  if (isThemeChoice(device)) return device;
  if (isThemeChoice(account)) return account;
  return "system";
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** The choice stored on this device, or null when there is none (never set, private mode, storage blocked). */
export function readStoredChoice(storage: StorageLike | null = defaultStorage()): ThemeChoice | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(value) ? value : null;
  } catch { return null; }
}

/** False when the device would not keep it (the page still follows it until it is closed). */
export function storeChoice(choice: ThemeChoice, storage: StorageLike | null = defaultStorage()): boolean {
  try { if (!storage) return false; storage.setItem(THEME_STORAGE_KEY, choice); return true; } catch { return false; }
}

function systemPrefersDark(): boolean {
  try { return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
}

/** The theme showing right now, as the document carries it. */
export function currentTheme(): ResolvedTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** The choice in force: what the document carries, else the device's stored one, else System. */
export function currentChoice(): ThemeChoice {
  if (typeof document !== "undefined") {
    const fromDocument = document.documentElement.dataset.themeChoice;
    if (isThemeChoice(fromDocument)) return fromDocument;
  }
  return readStoredChoice() ?? "system";
}

/** Puts the browser's chrome (address bar, installed app strip) and the Android status bar in step with a theme. */
function paintChrome(choice: ThemeChoice, theme: ResolvedTheme) {
  // Explicit choice: both tags carry the chosen colour. System: each tag keeps the colour for its own media query.
  for (const meta of Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))) {
    const media = meta.getAttribute("media") ?? "";
    const own: ResolvedTheme = /dark/.test(media) ? "dark" : "light";
    meta.setAttribute("content", THEME_COLORS[choice === "system" && media ? own : theme]);
  }
  // The Android app's status bar is native; the Capacitor StatusBar plugin is part of that build. The strip is
  // dark in both themes (navy / the dark theme's ink), so the icons stay light and only the colour follows.
  // A page in a browser has no such plugin and this does nothing.
  try {
    const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, Record<string, ((o: Record<string, string>) => unknown) | undefined> | undefined> } }).Capacitor;
    if (capacitor?.isNativePlatform?.()) {
      const bar = capacitor.Plugins?.StatusBar;
      void bar?.setStyle?.({ style: "DARK" });
      void bar?.setBackgroundColor?.({ color: THEME_COLORS[theme] });
    }
  } catch { /* not in the app */ }
}

/**
 * Makes a choice the one in force: updates the document, the browser chrome and the iPhone app's native frame.
 * `persist` also keeps it on this device (leave it off when only following a change of the device's setting).
 */
export function applyTheme(choice: ThemeChoice, options: { persist?: boolean } = {}): ResolvedTheme {
  const theme = resolveTheme(choice, systemPrefersDark());
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeChoice = choice;
  root.style.colorScheme = theme;
  if (options.persist) storeChoice(choice);
  paintChrome(choice, theme);
  // The iPhone frame's navigation bar, tab bar and Menu are native; it re-colours them (a no-op elsewhere).
  nativeFrame()?.post("theme", { choice, theme });
  return theme;
}

/**
 * Runs in the document head before the first paint (app/layout.tsx), so the page never shows the wrong theme
 * for a moment. Plain old JavaScript on purpose; it must mirror resolveTheme/readStoredChoice above.
 */
export const THEME_SCRIPT = `(function(){try{var d=document.documentElement,c=null;
try{c=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}
if(c!=='light'&&c!=='dark'&&c!=='system')c='system';
var dark=c==='dark'||(c==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
var t=dark?'dark':'light';
d.dataset.theme=t;d.dataset.themeChoice=c;d.style.colorScheme=t;
var cols={light:'${THEME_COLORS.light}',dark:'${THEME_COLORS.dark}'};
var m=document.querySelectorAll('meta[name="theme-color"]');
for(var i=0;i<m.length;i++){var md=m[i].getAttribute('media')||'';m[i].setAttribute('content',cols[c==='system'&&md?(/dark/.test(md)?'dark':'light'):t])}
}catch(e){}})();`;
