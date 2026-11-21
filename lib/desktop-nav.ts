/**
 * The desktop navigation: one sidebar, one name per place, and Admin as a mode.
 *
 * In a browser window at least 1024px wide (not the installed phone apps, which keep their bottom bar) every
 * signed-in page gets a sidebar with six main places and News below a rule. Pages that belong together
 * (Family: Children, Documents and forms, Dues; Classes, for anyone who teaches) share a tab strip under the
 * header instead of separate menu entries. Admin swaps the sidebar for its seven groups, each with its own tabs.
 *
 * Nothing here decides who may see a page: the pages check access themselves. This only decides what is shown.
 */

export type NavIcon =
  | "today" | "messages" | "calendar" | "classes" | "family" | "photos" | "news" | "admin" | "back"
  | "overview" | "people" | "comms" | "money" | "records" | "settings";

export type SideItem = { id: string; label: string; href: string; icon: NavIcon };

const FV = "/family-village";
export const ADMIN_PATH = `${FV}/admin`;

export const PORTAL_PRIMARY: SideItem[] = [
  { id: "today", label: "Today", href: `${FV}/home`, icon: "today" },
  { id: "messages", label: "Messages", href: `${FV}/messages`, icon: "messages" },
  { id: "calendar", label: "Calendar", href: `${FV}/calendar`, icon: "calendar" },
  { id: "classes", label: "Classes", href: `${FV}/classes`, icon: "classes" },
  { id: "family", label: "Family", href: `${FV}/children`, icon: "family" },
  { id: "photos", label: "Photos", href: `${FV}/photos`, icon: "photos" },
];

export const PORTAL_SECONDARY: SideItem[] = [
  { id: "news", label: "News", href: `${FV}/news`, icon: "news" },
];

export type AreaTab = { id: string; label: string; href: string; teachersOnly?: boolean };

export const FAMILY_TABS: AreaTab[] = [
  { id: "children", label: "Children", href: `${FV}/children` },
  { id: "documents", label: "Documents and forms", href: `${FV}/documents` },
  { id: "dues", label: "Dues", href: `${FV}/dues` },
];

/** Only shown to people who teach this year; everyone else has just the one Classes page, so no tabs at all. */
export const CLASSES_TABS: AreaTab[] = [
  { id: "classes-children", label: "Children’s classes", href: `${FV}/classes` },
  { id: "classes-teaching", label: "Classes I teach", href: `${FV}/teacher/classes`, teachersOnly: true },
  { id: "teaching-news", label: "Teaching news", href: `${FV}/teacher/news`, teachersOnly: true },
  { id: "print-queue", label: "Print queue", href: `${FV}/teacher/print`, teachersOnly: true },
];

export type AdminGroup = { id: string; label: string; hint: string; icon: NavIcon; tabs: { id: string; label: string }[] };

/** Every Admin tab in app/family-village/admin/workspace.tsx belongs to exactly one group (tests/desktop-nav.test.mjs). */
export const ADMIN_GROUPS: AdminGroup[] = [
  { id: "overview", label: "Overview", hint: "What needs attention", icon: "overview", tabs: [{ id: "dashboard", label: "Overview" }] },
  { id: "people", label: "People", hint: "Families and invitations", icon: "people", tabs: [{ id: "families", label: "Families" }, { id: "invitations", label: "Invitations" }] },
  { id: "classes", label: "Classes", hint: "Classes and enrollment", icon: "classes", tabs: [{ id: "classes", label: "Classes" }] },
  { id: "comms", label: "Messages and news", hint: "Inbox, news, broadcasts", icon: "comms", tabs: [
    { id: "inbox", label: "Office inbox" }, { id: "news", label: "News & calendar" }, { id: "broadcasts", label: "Broadcasts" }, { id: "message-reports", label: "Reported messages" },
  ] },
  { id: "money", label: "Money", hint: "Dues and expenses", icon: "money", tabs: [{ id: "dues", label: "Dues" }, { id: "expenses", label: "Expenses" }] },
  { id: "records", label: "Records", hint: "Documents, reports, compliance", icon: "records", tabs: [{ id: "documents", label: "Documents" }, { id: "reports", label: "Reports" }, { id: "deadlines", label: "Compliance" }, { id: "activity", label: "Activity" }] },
  { id: "settings", label: "Settings", hint: "Appearance, integrations", icon: "settings", tabs: [{ id: "appearance", label: "Appearance" }, { id: "integrations", label: "Integrations" }] },
];

const tidy = (pathname: string) => pathname.replace(/\/+$/, "") || "/";
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Which sidebar place a page belongs to, or null for pages outside it (sign-in, notifications). */
export function activePortalItem(pathname: string): string | null {
  const path = tidy(pathname);
  if (path === `${FV}/home`) return "today";
  if (under(path, `${FV}/messages`)) return "messages";
  if (under(path, `${FV}/calendar`)) return "calendar";
  if (under(path, `${FV}/classes`) || under(path, `${FV}/teacher`)) return "classes";
  if (["children", "documents", "dues", "paperwork"].some((part) => under(path, `${FV}/${part}`))) return "family";
  if (under(path, `${FV}/photos`)) return "photos";
  if (under(path, `${FV}/news`)) return "news";
  return null;
}

/** The tab strip for this page, if it belongs to an area with more than one page. */
export function areaFor(pathname: string, teaches: boolean): { label: string; tabs: AreaTab[]; active: string } | null {
  const path = tidy(pathname);
  const family = FAMILY_TABS.find((tab) => path === tab.href) ?? (under(path, `${FV}/paperwork`) ? FAMILY_TABS[1] : undefined);
  if (family) return { label: "Family", tabs: FAMILY_TABS, active: family.id };
  if (!teaches) return null;
  const teacherHome = path === `${FV}/teacher`;
  const tab = teacherHome ? CLASSES_TABS[1] : CLASSES_TABS.find((row) => path === row.href);
  return tab ? { label: "Classes", tabs: CLASSES_TABS, active: tab.id } : null;
}

const ADMIN_TAB_IDS = ADMIN_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id));

/** The Admin tab named in the address (?tab=), or the overview. */
export function adminTabFrom(search: string): string {
  const raw = new URLSearchParams(search).get("tab") ?? "";
  // Compliance was folded into Documents (the workspace does the same).
  const wanted = raw === "compliance" ? "documents" : raw;
  return ADMIN_TAB_IDS.includes(wanted) ? wanted : "dashboard";
}

export function adminGroupOf(tab: string): AdminGroup {
  return ADMIN_GROUPS.find((group) => group.tabs.some((row) => row.id === tab)) ?? ADMIN_GROUPS[0];
}

export function adminHref(tab: string): string {
  return tab === "dashboard" ? ADMIN_PATH : `${ADMIN_PATH}?tab=${tab}`;
}

/** Opens the sidebar as a drawer on a narrow screen (the header's Menu button sends it). */
export const DRAWER_EVENT = "vv-drawer-open";

/** Asks the Admin workspace to switch tab in place, without reloading the page. */
export const ADMIN_TAB_EVENT = "vv-admin-tab";

/* ---------- Jump to a page ---------- */

export type JumpEntry = { id: string; label: string; trail: string; href: string; words: string; adminTab?: string };

const WORDS: Record<string, string> = {
  today: "home dashboard week start",
  messages: "chat dm direct channel inbox talk write",
  calendar: "events dates schedule friday co-op day",
  classes: "class teacher roster lessons",
  family: "household kids",
  photos: "pictures gallery yearbook images",
  news: "notices announcements posts",
  children: "kids enroll enrollment child profiles",
  documents: "forms waiver handbook sign signature paperwork files handouts",
  dues: "pay payment money balance fees tuition",
  "classes-children": "kids classes",
  "classes-teaching": "teach my classes roster",
  "teaching-news": "team news teachers lounge",
  "print-queue": "printer printing handouts copies",
  dashboard: "admin overview attention",
  families: "people households roster directory",
  invitations: "invite invites new family welcome",
  inbox: "email office mail",
  broadcasts: "urgent text alert",
  "message-reports": "flagged reported messaging moderation",
  expenses: "receipts reimbursements spending",
  reports: "export csv roster print",
  deadlines: "compliance irs tax 990 filing deadlines renewals 1099 nonprofit",
  activity: "log audit history",
  appearance: "theme colours colors logo seasonal brand",
  integrations: "services stripe email push",
};

/** Every page a person can jump to, in sidebar order, with Admin last and only for admins. */
export function jumpEntries(roles: string[]): JumpEntry[] {
  const teaches = roles.includes("teacher");
  const entries: JumpEntry[] = [];
  for (const item of [...PORTAL_PRIMARY, ...PORTAL_SECONDARY]) {
    entries.push({ id: item.id, label: item.label, trail: "", href: item.href, words: WORDS[item.id] ?? "" });
  }
  for (const tab of FAMILY_TABS) entries.push({ id: tab.id, label: tab.label, trail: "Family", href: tab.href, words: WORDS[tab.id] ?? "" });
  if (teaches) for (const tab of CLASSES_TABS) entries.push({ id: tab.id, label: tab.label, trail: "Classes", href: tab.href, words: WORDS[tab.id] ?? "" });
  if (roles.includes("admin")) {
    for (const group of ADMIN_GROUPS) for (const tab of group.tabs) {
      const trail = group.tabs.length > 1 ? `Admin › ${group.label}` : "Admin";
      entries.push({ id: `admin-${tab.id}`, label: tab.label, trail, href: adminHref(tab.id), words: `admin ${WORDS[tab.id] ?? ""}`, adminTab: tab.id });
    }
  }
  return entries;
}

/** Best matches first: a label that starts with the words, then one that contains them, then a synonym. */
export function searchJump(entries: JumpEntry[], query: string, limit = 8): JumpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.filter((entry) => !entry.trail).slice(0, limit);
  const scored: { entry: JumpEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const label = entry.label.toLowerCase();
    const trail = entry.trail.toLowerCase();
    const words = entry.words.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 4;
    else if (label.split(/\s+/).some((word) => word.startsWith(q))) score = 3;
    else if (label.includes(q) || trail.includes(q)) score = 2;
    else if (words.split(/\s+/).some((word) => word.startsWith(q)) || words.includes(q)) score = 1;
    if (score) scored.push({ entry, score: score - (entry.adminTab ? 0.5 : 0), order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map((row) => row.entry);
}

/* ---------- Small moments ---------- */

export type Season = "autumn" | "winter" | "spring" | "summer";

export function seasonOf(date: Date): Season {
  const month = date.getMonth();
  if (month >= 8 && month <= 10) return "autumn";
  if (month === 11 || month <= 1) return "winter";
  if (month <= 4) return "spring";
  return "summer";
}

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export function dayPartOf(date: Date): DayPart {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

export function greeting(part: DayPart, name: string): string {
  const who = name ? `, ${name}` : "";
  if (part === "morning") return `Good morning${who}`;
  if (part === "afternoon") return `Good afternoon${who}`;
  if (part === "evening") return `Good evening${who}`;
  return `Burning the midnight oil${who}?`;
}

/* ---------- Tucked away ---------- */

/** localStorage key for the sidebar's tucked-away choice ("collapsed" or "open"), per device. */
export const SIDENAV_KEY = "vv-sidenav";

/** Runs in <head> before the first paint, so a tucked-away sidebar never flashes open and the page never jumps. */
export const SIDENAV_SCRIPT = `try{if(localStorage.getItem("${SIDENAV_KEY}")==="collapsed")document.documentElement.dataset.sidenav="collapsed"}catch(e){}`;
