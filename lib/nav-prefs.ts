/**
 * The bottom bar of the installed and native apps, the Menu behind it, and what
 * each person has chosen to put on the bar.
 *
 * Family and Teaching are one portal: one bar and one flat Menu. Teaching items
 * (Teaching, Team news, My classes, Print queue) sit among the family ones for
 * anyone who teaches (see lib/teaching-access.ts), with no separate "Teacher
 * portal" to switch into. Admin stays apart on purpose: its own bar, its own
 * Menu block, and a denser navy look, so it is hard to enter by accident.
 *
 * Each bar is a list of up to MAX_SLOTS destinations, in the order chosen, with
 * a fixed Menu button after them.
 */

/** The two bars. Teacher pages use the "home" bar (see `sectionOf`). */
export type Section = "home" | "admin";
/** What a page's header may say it belongs to. "teacher" is the Teacher pages, which are part of the main portal. */
export type PortalKey = Section | "teacher";
export type IconName =
  | "home" | "photos" | "messages" | "menu" | "news" | "calendar" | "children" | "paperwork"
  | "teach" | "classes" | "dashboard" | "families" | "invitations" | "compliance"
  | "reports" | "activity" | "integrations" | "flag";

export type Destination = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Teaching items need teaching access, Admin items the admin role; everything else is for everyone. */
  role?: "teacher" | "admin";
  /** "portal" is Family and Teaching together; "admin" is set apart. */
  area: "portal" | "admin";
};

/** Five shortcuts plus the Menu button: the most a phone-width bar can hold and still read. */
export const MAX_SLOTS = 5;

const FAMILY = "/family-village/home";
const TEACHER = "/family-village/teacher";
const ADMIN = "/family-village/admin";

export const DESTINATIONS: Destination[] = [
  { id: "home", label: "Home", href: FAMILY, icon: "home", area: "portal" },
  { id: "news", label: "News", href: "/family-village/news", icon: "news", area: "portal" },
  { id: "calendar", label: "Calendar", href: "/family-village/calendar", icon: "calendar", area: "portal" },
  { id: "children", label: "Children", href: "/family-village/children", icon: "children", area: "portal" },
  { id: "family-classes", label: "Classes", href: "/family-village/classes", icon: "classes", area: "portal" },
  { id: "documents", label: "Documents", href: "/family-village/documents", icon: "paperwork", area: "portal" },
  { id: "photos", label: "Photos", href: "/family-village/photos", icon: "photos", area: "portal" },
  { id: "messages", label: "Messages", href: "/family-village/messages", icon: "messages", area: "portal" },
  { id: "teacher-home", label: "Teaching", href: TEACHER, icon: "teach", role: "teacher", area: "portal" },
  { id: "teacher-news", label: "Team news", href: `${TEACHER}/news`, icon: "news", role: "teacher", area: "portal" },
  { id: "teacher-classes", label: "My classes", href: `${TEACHER}/classes`, icon: "classes", role: "teacher", area: "portal" },
  { id: "teacher-lounge", label: "Print queue", href: `${TEACHER}/print`, icon: "paperwork", role: "teacher", area: "portal" },
  { id: "admin-dashboard", label: "Dashboard", href: ADMIN, icon: "dashboard", role: "admin", area: "admin" },
  { id: "admin-families", label: "Families", href: `${ADMIN}?tab=families`, icon: "families", role: "admin", area: "admin" },
  { id: "admin-classes", label: "Classes", href: `${ADMIN}?tab=classes`, icon: "classes", role: "admin", area: "admin" },
  { id: "admin-invitations", label: "Invites", href: `${ADMIN}?tab=invitations`, icon: "invitations", role: "admin", area: "admin" },
  { id: "admin-documents", label: "Documents", href: `${ADMIN}?tab=documents`, icon: "compliance", role: "admin", area: "admin" },
  { id: "admin-news", label: "News", href: `${ADMIN}?tab=news`, icon: "news", role: "admin", area: "admin" },
  { id: "admin-reports", label: "Reports", href: `${ADMIN}?tab=reports`, icon: "reports", role: "admin", area: "admin" },
  { id: "admin-activity", label: "Activity", href: `${ADMIN}?tab=activity`, icon: "activity", role: "admin", area: "admin" },
  { id: "admin-flagged", label: "Messaging", href: `${ADMIN}?tab=message-reports`, icon: "flag", role: "admin", area: "admin" },
  { id: "admin-integrations", label: "Services", href: `${ADMIN}?tab=integrations`, icon: "integrations", role: "admin", area: "admin" },
];

export const SECTION_LABELS: Record<Section, string> = { home: "Main bar", admin: "Admin bar" };

/** What each bar shows until someone changes it. Teaching drops out by itself for people who do not teach. */
export const DEFAULT_BARS: Record<Section, string[]> = {
  home: ["home", "teacher-home", "photos", "messages"],
  admin: ["home", "admin-dashboard", "photos", "messages"],
};

/**
 * What is stored per person (user_nav_prefs.prefs) and cached on the device.
 * `teacher` is the old Teacher bar: it is read once, merged into `home` (see cleanPrefs) and never written
 * back. `legacy` keeps the two original lists from before that merge, so a person's earlier choices are
 * still on file, and `resolveBar` never needs them.
 */
export type NavPrefs = {
  home?: string[];
  admin?: string[];
  teacher?: string[];
  legacy?: { home?: string[]; teacher?: string[] };
  /** Light, Dark or System (lib/theme.ts). Not a bar setting, but it lives in the same small per-person record. */
  theme?: "system" | "light" | "dark";
};

const byId = new Map(DESTINATIONS.map((d) => [d.id, d]));

/** Destinations that were merged into another. A bar saved with the old id keeps its slot under the new one. */
const RENAMED: Record<string, string> = { paperwork: "documents", "admin-compliance": "admin-documents" };
const current = (id: string) => RENAMED[id] ?? id;

export function destination(id: string): Destination | undefined {
  return byId.get(id);
}

/** Which bar a page belongs to: the Teacher pages share the main one. */
export function sectionOf(key: PortalKey): Section {
  return key === "admin" ? "admin" : "home";
}

/**
 * Destinations this person may use. `roles` is their roles plus "teacher" when they teach this year
 * (`withTeaching` adds it), so a parent who is assigned a class sees Teaching, and one who bought out of
 * teaching does not.
 */
export function availableDestinations(roles: string[]): Destination[] {
  return DESTINATIONS.filter((d) => !d.role || roles.includes(d.role));
}

/** Their roles, plus "teacher" when they have a class this school year (the rule: lib/teaching-access.ts). */
export function withTeaching(roles: string[], teachesThisYear: boolean): string[] {
  return teachesThisYear && !roles.includes("teacher") ? [...roles, "teacher"] : roles;
}

/** Known destinations only, current ids, no repeats, in order. Not limited to what a role allows or to MAX_SLOTS. */
function known(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  for (const stored of ids) {
    const id = typeof stored === "string" ? current(stored) : "";
    if (id && byId.has(id)) seen.add(id);
  }
  return [...seen];
}

/**
 * Turns whatever was stored into a safe bar: known destinations only, ones the person's roles allow, no
 * repeats, at most MAX_SLOTS, falling back to the default if nothing usable is left (a role may have been
 * removed since).
 */
export function resolveBar(prefs: NavPrefs | null | undefined, section: Section, roles: string[]): Destination[] {
  const allowed = new Set(availableDestinations(roles).map((d) => d.id));
  const pick = (ids: unknown): Destination[] => known(ids).filter((id) => allowed.has(id)).slice(0, MAX_SLOTS).map((id) => byId.get(id)!);
  const chosen = pick(prefs?.[section]);
  return chosen.length ? chosen : pick(DEFAULT_BARS[section]);
}

/**
 * Keeps only well-formed bars, so a bad stored value can never break the bar, and folds an old Teacher bar
 * into the main one.
 *
 * Before Family and Teaching became one portal each had its own bar. The merge keeps the main bar as it was,
 * then adds the Teacher bar's items that are not already there, drops duplicates and stops at MAX_SLOTS.
 * Anything squeezed out is still in the Menu, and the original lists are kept under `legacy`. Merging again
 * on already-merged prefs changes nothing (the `teacher` key is gone after the first save).
 */
export function cleanPrefs(value: unknown): NavPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: NavPrefs = {};

  const home = Array.isArray(raw.home) ? known(raw.home) : undefined;
  const teacher = Array.isArray(raw.teacher) ? known(raw.teacher) : undefined;
  if (teacher !== undefined) {
    // "home" in the Teacher bar's list is the same Home as the main bar's, so it merges away as a duplicate.
    out.home = [...new Set([...(home ?? []), ...teacher])].slice(0, MAX_SLOTS);
    out.legacy = { ...(home ? { home } : {}), teacher };
  } else if (home !== undefined) {
    out.home = home.slice(0, MAX_SLOTS);
  }
  if (Array.isArray(raw.admin)) out.admin = known(raw.admin).slice(0, MAX_SLOTS);
  if (raw.theme === "system" || raw.theme === "light" || raw.theme === "dark") out.theme = raw.theme;

  // Carry the earlier lists along, untouched by later saves.
  const legacy = raw.legacy;
  if (!out.legacy && legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const l = legacy as Record<string, unknown>;
    out.legacy = {
      ...(Array.isArray(l.home) ? { home: known(l.home) } : {}),
      ...(Array.isArray(l.teacher) ? { teacher: known(l.teacher) } : {}),
    };
  }
  return out;
}

/** Whether a destination is the page being looked at. */
export function isActive(dest: Destination, rawPathname: string, hash: string, search: string): boolean {
  const pathname = rawPathname.replace(/\/$/, "");
  const [pathAndQuery, anchor = ""] = dest.href.split("#");
  const [path, query = ""] = pathAndQuery.split("?");
  if (pathname !== path && !(path !== FAMILY && path !== TEACHER && path !== ADMIN && pathname.startsWith(path))) return false;
  if (anchor) return hash === `#${anchor}`;
  if (query) return search.includes(query);
  // A plain section home is "active" only when no sibling anchor or tab is selected.
  if (path === FAMILY || path === TEACHER) return hash === "";
  if (path === ADMIN) return !search.includes("tab=");
  return true;
}

const CACHE_KEY = "vv-nav-prefs";
const SECTION_KEY = "vv-last-section";
const TEACHES_KEY = "vv-teaches";

export function readCachedPrefs(): NavPrefs {
  try { return cleanPrefs(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null")); } catch { return {}; }
}
export function writeCachedPrefs(prefs: NavPrefs) {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(prefs)); } catch { /* private mode: the saved copy still syncs */ }
}
/** Messages, Photos and Calendar belong to whichever bar was visited last: the main one, or Admin's. */
export function readLastSection(): Section {
  try { return window.localStorage.getItem(SECTION_KEY) === "admin" ? "admin" : "home"; } catch { return "home"; }
}
export function writeLastSection(section: Section) {
  try { window.localStorage.setItem(SECTION_KEY, section); } catch { /* ignore */ }
}

/** Whether this device last saw the person teaching, so Teaching is on the bar from the first paint. */
export function readCachedTeaches(): boolean {
  try { return window.localStorage.getItem(TEACHES_KEY) === "1"; } catch { return false; }
}
export function writeCachedTeaches(teaches: boolean) {
  try { window.localStorage.setItem(TEACHES_KEY, teaches ? "1" : "0"); } catch { /* ignore */ }
}
/** On sign-out: the next person to use this device must not start from the last person's bar. */
export function clearNavCache() {
  try { for (const key of [CACHE_KEY, SECTION_KEY, TEACHES_KEY]) window.localStorage.removeItem(key); } catch { /* ignore */ }
}
