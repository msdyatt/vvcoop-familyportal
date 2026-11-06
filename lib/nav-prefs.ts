/**
 * The bottom bar of the installed and native apps, and what each person has
 * chosen to put on it. The bar is per section (Family, Teacher, Admin): each
 * keeps its own list of up to MAX_SLOTS destinations, in the order chosen,
 * with a fixed Menu button after them.
 */

export type Section = "home" | "teacher" | "admin";
export type IconName =
  | "home" | "photos" | "messages" | "menu" | "news" | "calendar" | "children" | "paperwork"
  | "teach" | "classes" | "dashboard" | "families" | "invitations" | "compliance"
  | "reports" | "activity" | "integrations" | "flag";

export type Destination = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Needs this role to appear in the pool. */
  role?: "teacher" | "admin";
  group: "Family" | "Everywhere" | "Teaching" | "Administration";
};

export const MAX_SLOTS = 4;

const FAMILY = "/family-village/home";
const TEACHER = "/family-village/teacher";
const ADMIN = "/family-village/admin";

export const DESTINATIONS: Destination[] = [
  { id: "home", label: "Home", href: FAMILY, icon: "home", group: "Family" },
  { id: "news", label: "News", href: `${FAMILY}#news`, icon: "news", group: "Family" },
  { id: "calendar", label: "Calendar", href: "/family-village/calendar", icon: "calendar", group: "Everywhere" },
  { id: "children", label: "Children", href: `${FAMILY}#my-children`, icon: "children", group: "Family" },
  { id: "paperwork", label: "Paperwork", href: `${FAMILY}#paperwork`, icon: "paperwork", group: "Family" },
  { id: "photos", label: "Photos", href: "/family-village/photos", icon: "photos", group: "Everywhere" },
  { id: "messages", label: "Messages", href: "/family-village/messages", icon: "messages", group: "Everywhere" },
  { id: "teacher-home", label: "Teaching", href: TEACHER, icon: "teach", role: "teacher", group: "Teaching" },
  { id: "teacher-classes", label: "My classes", href: `${TEACHER}#classes`, icon: "classes", role: "teacher", group: "Teaching" },
  { id: "teacher-lounge", label: "Lounge", href: `${TEACHER}#lounge`, icon: "news", role: "teacher", group: "Teaching" },
  { id: "admin-dashboard", label: "Dashboard", href: ADMIN, icon: "dashboard", role: "admin", group: "Administration" },
  { id: "admin-families", label: "Families", href: `${ADMIN}?tab=families`, icon: "families", role: "admin", group: "Administration" },
  { id: "admin-classes", label: "Classes", href: `${ADMIN}?tab=classes`, icon: "classes", role: "admin", group: "Administration" },
  { id: "admin-invitations", label: "Invites", href: `${ADMIN}?tab=invitations`, icon: "invitations", role: "admin", group: "Administration" },
  { id: "admin-compliance", label: "Compliance", href: `${ADMIN}?tab=compliance`, icon: "compliance", role: "admin", group: "Administration" },
  { id: "admin-news", label: "News", href: `${ADMIN}?tab=news`, icon: "news", role: "admin", group: "Administration" },
  { id: "admin-reports", label: "Reports", href: `${ADMIN}?tab=reports`, icon: "reports", role: "admin", group: "Administration" },
  { id: "admin-activity", label: "Activity", href: `${ADMIN}?tab=activity`, icon: "activity", role: "admin", group: "Administration" },
  { id: "admin-flagged", label: "Messaging", href: `${ADMIN}?tab=message-reports`, icon: "flag", role: "admin", group: "Administration" },
  { id: "admin-integrations", label: "Services", href: `${ADMIN}?tab=integrations`, icon: "integrations", role: "admin", group: "Administration" },
];

export const SECTION_LABELS: Record<Section, string> = { home: "Family", teacher: "Teacher", admin: "Admin" };

/** What each section's bar shows until someone changes it. */
export const DEFAULT_BARS: Record<Section, string[]> = {
  home: ["home", "photos", "messages"],
  teacher: ["home", "teacher-home", "photos", "messages"],
  admin: ["home", "admin-dashboard", "photos", "messages"],
};

export type NavPrefs = Partial<Record<Section, string[]>>;

const byId = new Map(DESTINATIONS.map((d) => [d.id, d]));

export function destination(id: string): Destination | undefined {
  return byId.get(id);
}

/** Destinations this person may use, given their roles. */
export function availableDestinations(roles: string[]): Destination[] {
  return DESTINATIONS.filter((d) => !d.role || roles.includes(d.role));
}

/**
 * Turns whatever was stored into a safe bar: known destinations only, ones the
 * person's roles allow, no repeats, at most MAX_SLOTS, falling back to the
 * default if nothing usable is left (a role may have been removed since).
 */
export function resolveBar(prefs: NavPrefs | null | undefined, section: Section, roles: string[]): Destination[] {
  const allowed = new Set(availableDestinations(roles).map((d) => d.id));
  const pick = (ids: unknown): Destination[] => {
    if (!Array.isArray(ids)) return [];
    const seen = new Set<string>();
    const out: Destination[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id) || !allowed.has(id)) continue;
      seen.add(id);
      out.push(byId.get(id)!);
      if (out.length === MAX_SLOTS) break;
    }
    return out;
  };
  const chosen = pick(prefs?.[section]);
  return chosen.length ? chosen : pick(DEFAULT_BARS[section]);
}

/** Keeps only well-formed sections, so a bad stored value can never break the bar. */
export function cleanPrefs(value: unknown): NavPrefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: NavPrefs = {};
  for (const section of ["home", "teacher", "admin"] as const) {
    const ids = (value as Record<string, unknown>)[section];
    if (Array.isArray(ids)) out[section] = ids.filter((id): id is string => typeof id === "string" && byId.has(id)).slice(0, MAX_SLOTS);
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

export function readCachedPrefs(): NavPrefs {
  try { return cleanPrefs(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null")); } catch { return {}; }
}
export function writeCachedPrefs(prefs: NavPrefs) {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(prefs)); } catch { /* private mode: the saved copy still syncs */ }
}
export function readLastSection(): Section {
  try {
    const value = window.localStorage.getItem(SECTION_KEY);
    return value === "teacher" || value === "admin" ? value : "home";
  } catch { return "home"; }
}
export function writeLastSection(section: Section) {
  try { window.localStorage.setItem(SECTION_KEY, section); } catch { /* ignore */ }
}
