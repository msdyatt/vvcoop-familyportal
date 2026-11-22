/**
 * The signed-in portal's frame: which pages have the shared header and sidebar, what each one says before the
 * page itself has loaded, and how a click on an internal link moves between pages without reloading the document.
 *
 * app/family-village/layout.tsx draws the header, sidebar, bell and bottom bar once (portal-frame.tsx), so they stay
 * mounted while only the page under them changes. Each page tells the frame its title with <PortalPage>.
 */
import type { PortalKey } from "./nav-prefs";

export type PortalView = "home" | "children" | "news" | "classes" | "documents";
export type TeacherView = "home" | "news" | "print";
export type ClassesScope = "teaching" | "family" | "both";
type Head = { title: string; subtitle: string };

export const VIEW_HEADERS: Record<PortalView, Head> = {
  home: { title: "Today", subtitle: "Your household’s week, gathered in one place." },
  children: { title: "Your children", subtitle: "Profiles, classes and enrollment." },
  news: { title: "News & notices", subtitle: "From the co-op." },
  classes: { title: "Classes", subtitle: "Dates and prep for your children’s classes." },
  documents: { title: "Documents", subtitle: "Forms to sign, dues, and files shared with your household." },
};

export const TEACHER_HEADERS: Record<TeacherView, Head> = {
  home: { title: "Teacher’s Lounge", subtitle: "Your classes, team news and printing in one place." },
  news: { title: "Teaching team news", subtitle: "Announcements for the teaching team." },
  print: { title: "Print queue", subtitle: "Handouts waiting for the office printer." },
};

export const CLASSES_HEADERS: Record<ClassesScope, Head> = {
  teaching: { title: "My classes", subtitle: "The classes you teach this year." },
  family: { title: "Classes", subtitle: "Your children’s classes, dates and files." },
  both: { title: "Classes", subtitle: "Classes you teach and your children’s classes." },
};

export const COOP_DAYS_HEADER: Head = {
  title: "Co-op days",
  subtitle: "Your teaching and assisting shifts, days you can't make it, and shifts to cover.",
};

/** What the shared header shows. Null means the page has no header (a sign-in prompt, a second-factor screen). */
export type ChromeHeader = { current: PortalKey; roles: string[]; title: string; subtitle?: string };
/** What a page tells the frame: the class for the page's <main> and its header. */
export type ChromePage = { className: string; header: ChromeHeader | null };

const BASE = "/family-village";
const head = (current: PortalKey, h: { title: string; subtitle?: string }): ChromeHeader => ({ current, roles: [], ...h });

/**
 * The pages drawn inside the shared frame, and what each shows while it is still loading (the server render and
 * the first paint, before the page has said anything itself). Pages not listed here (sign-in, accepting an
 * invitation, the preview, the iPhone app's own screens) draw their whole screen themselves.
 */
const ROUTES: Record<string, ChromePage> = {
  "/home": { className: "live-portal", header: head("home", VIEW_HEADERS.home) },
  "/children": { className: "live-portal", header: head("home", VIEW_HEADERS.children) },
  "/news": { className: "live-portal", header: head("home", VIEW_HEADERS.news) },
  "/documents": { className: "live-portal", header: head("home", VIEW_HEADERS.documents) },
  "/messages": { className: "workspace-preview messages-page", header: head("home", { title: "Messages", subtitle: "Talk with teachers and other families." }) },
  "/calendar": { className: "workspace-preview calendar-page", header: head("home", { title: "Calendar", subtitle: "Co-op dates and class dates." }) },
  "/co-op-days": { className: "workspace-preview coop-days-page", header: head("home", COOP_DAYS_HEADER) },
  "/classes": { className: "workspace-preview cls-page", header: head("home", CLASSES_HEADERS.family) },
  "/classes/view": { className: "workspace-preview cls-page", header: head("home", { title: "Class" }) },
  "/dues": { className: "workspace-preview dues-page", header: head("home", { title: "Dues", subtitle: "What you owe, what you have paid, and receipts." }) },
  "/photos": { className: "workspace-preview photos-page", header: head("home", { title: "Photos", subtitle: "The co-op's shared library, kept here." }) },
  "/paperwork/sign": { className: "workspace-preview", header: null },
  "/admin": { className: "admin-live", header: head("admin", { title: "Village administration", subtitle: "Invite families, manage rosters, and publish news." }) },
  "/teacher": { className: "workspace-preview", header: head("teacher", TEACHER_HEADERS.home) },
  "/teacher/news": { className: "workspace-preview", header: head("teacher", TEACHER_HEADERS.news) },
  "/teacher/print": { className: "workspace-preview", header: head("teacher", TEACHER_HEADERS.print) },
  "/teacher/classes": { className: "workspace-preview cls-page", header: head("teacher", CLASSES_HEADERS.teaching) },
};

function routeKey(pathname: string): string | null {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return null;
  const rest = pathname.slice(BASE.length).replace(/\/+$/, "");
  return rest in ROUTES ? rest : null;
}

/** Whether this address is one of the pages inside the shared frame. */
export function isFramedPath(pathname: string): boolean {
  return routeKey(pathname) !== null;
}

/** What the frame shows for a page before the page has said anything itself. */
export function chromeForPath(pathname: string): ChromePage | null {
  const key = routeKey(pathname);
  return key ? ROUTES[key] : null;
}

/** The parts of a click that decide whether it can be a client-side move. Mirrors MouseEvent and the link. */
export type LinkClick = {
  button: number;
  metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  defaultPrevented: boolean;
  /** The link's resolved href (anchor.href), its target and download attributes. */
  href: string; target: string; download: boolean;
  /** data-hard-nav on the link: always load the whole document (sign-out, a fresh start). */
  hardNav: boolean;
};

/**
 * Whether a click on a link can move between portal pages in place (true), or must be left to the browser
 * (false): a new tab or window, a download, another site, a file, a jump within the same page, or something the
 * page has already handled itself. Returns the path to move to.
 */
export function clientHref(click: LinkClick, location: { origin: string; pathname: string; search: string }): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (click.download || click.hardNav) return null;
  if (click.target && click.target !== "_self") return null;
  let url: URL;
  try { url = new URL(click.href, location.origin); } catch { return null; }
  if (url.origin !== location.origin) return null;
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  // A file under the portal's address (a vendored PDF, an image): let the browser have it.
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
  // Only a #fragment differs: the browser scrolls within the page.
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

type Mover = (href: string) => void;
let mover: Mover | null = null;

/** The frame registers the router's push here, so code outside React can move between pages too. */
export function setPortalMover(next: Mover | null) {
  mover = next;
}

/**
 * Go to another page. Inside the portal frame on the web this swaps the page and keeps the header, sidebar and
 * bell where they are. Anywhere else (a page without the frame, the iPhone app, which opens each page as its own
 * native screen, or another site) it loads the address the ordinary way.
 */
export function goTo(href: string) {
  if (typeof window === "undefined") return;
  const native = Boolean((window as unknown as { VVNative?: { frame?: boolean } }).VVNative?.frame);
  if (mover && !native) {
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) {
        mover(`${url.pathname}${url.search}${url.hash}`);
        return;
      }
    } catch { /* not a URL: fall through */ }
  }
  window.location.assign(href);
}
