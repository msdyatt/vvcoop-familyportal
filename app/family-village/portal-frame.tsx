"use client";

import { Fragment, createContext, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "./app-header";
import { nativeFrame } from "../../lib/native-frame";
import { chromeForPath, clientHref, isFramedPath, setPortalMover, type ChromePage } from "../../lib/portal-chrome";
import { APP_VERSION_PATH, isOutOfDate } from "../../lib/build-id";

/** How often an open tab asks whether a newer build is live (also when it comes back into view, and after a move). */
const VERSION_CHECK_MS = 60_000;

type Register = (page: ChromePage) => () => void;

/** How a page (through <PortalPage>) tells the frame its title. Null outside the frame. */
export const PortalFrameContext = createContext<Register | null>(null);

const locKey = (pathname: string, search: string) => `${pathname}?${new URLSearchParams(search).toString()}`;

/**
 * The portal's frame, drawn once by app/family-village/layout.tsx: the header, sidebar, bell, tab strip and bottom
 * bar stay mounted while the page under them changes, and a click on an internal link swaps the page in place
 * instead of loading a new document (lib/portal-chrome.ts says which clicks qualify).
 *
 * The DOM is the same as when each page drew its own header: <main class="..."> holding the shell and then the
 * page, so the stylesheets did not have to change.
 */
export default function PortalFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const search = useSearchParams()?.toString() ?? "";
  const router = useRouter();
  const framed = isFramedPath(pathname);

  // Pages register what the header says; the latest one wins (an old page's clean-up and a new page's
  // registration land in the same commit, so the header never blinks out between them).
  const entries = useRef(new Map<number, ChromePage>());
  const seq = useRef(0);
  const [page, setPage] = useState<ChromePage | null>(null);
  const [ready, setReady] = useState(false);
  const register = useCallback<Register>((entry) => {
    const id = ++seq.current;
    entries.current.set(id, entry);
    setPage(entry);
    return () => {
      entries.current.delete(id);
      const rest = [...entries.current.values()];
      setPage(rest.length ? rest[rest.length - 1] : null);
    };
  }, []);
  // Until hydration the frame draws what the address says (the same thing the server drew); from then on, what the
  // page says. Pages register in their own layout effects, which run before this one.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- flips once, after the pages have registered
  useLayoutEffect(() => { setReady(true); }, []);

  // The pages were written for a fresh document each time: they read the address once, when they mount. So a move
  // made here that changes only the query (?c= for another conversation) mounts the page afresh, as a reload did.
  // Address changes the page makes itself (Admin's ?tab=, a class page's #section) do not.
  const loc = locKey(pathname, search);
  const [armed, setArmed] = useState<string | null>(null);
  const [pageKey, setPageKey] = useState(loc);
  const [again, setAgain] = useState(0);
  if (armed !== null && armed === loc) {
    setArmed(null);
    if (pageKey !== loc) setPageKey(loc);
  }

  // Moving in place keeps this tab's code and styles, so after a deploy it would carry on with the old ones until
  // someone reloaded. Ask now and then whether a newer build is live; once one is, the next move loads the page fresh.
  const outOfDate = useRef(false);
  const lastCheck = useRef(0);
  const checkVersion = useCallback(async () => {
    if (outOfDate.current || Date.now() - lastCheck.current < VERSION_CHECK_MS) return;
    lastCheck.current = Date.now();
    try {
      const response = await fetch(APP_VERSION_PATH, { cache: "no-store", credentials: "same-origin" });
      if (response.ok && isOutOfDate(await response.json())) outOfDate.current = true;
    } catch { /* offline or blocked: carry on in place */ }
  }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void checkVersion(); };
    const timer = window.setInterval(() => void checkVersion(), VERSION_CHECK_MS * 5);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", onVisible); };
  }, [checkVersion]);

  const move = useCallback((href: string) => {
    if (outOfDate.current) { window.location.assign(href); return; }
    const url = new URL(href, window.location.origin);
    const target = locKey(url.pathname, url.search);
    if (target === locKey(window.location.pathname, window.location.search) && !url.hash) {
      // The page already showing: start it afresh at the top, as a reload would.
      setAgain((n) => n + 1);
      window.scrollTo({ top: 0 });
      return;
    }
    setArmed(target);
    router.push(href);
  }, [router]);

  useEffect(() => {
    setPortalMover(move);
    return () => setPortalMover(null);
  }, [move]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // The iPhone app opens every link as its own native screen, so it must see the real navigation.
      if (nativeFrame()) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = clientHref({
        button: event.button, metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        href: anchor.href, target: anchor.target, download: anchor.hasAttribute("download"), hardNav: anchor.hasAttribute("data-hard-nav"),
      }, window.location);
      if (!href) return;
      event.preventDefault();
      move(href);
    }
    // On window, in the bubbling phase: React's own handlers (which may prevent the default) have run by then.
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [move]);

  // The sidebar, tab strip and bottom bar re-read the address on this event (they were written for popstate).
  // A new document used to tell a screen reader where it had arrived; after a move the page title is read out.
  const [announce, setAnnounce] = useState("");
  const firstLoc = useRef(loc);
  useEffect(() => {
    window.dispatchEvent(new Event("vv-locationchange"));
    void checkVersion();
    if (loc === firstLoc.current) return;
    const frame = window.requestAnimationFrame(() => setAnnounce(document.querySelector(".app-header h1")?.textContent || document.title));
    return () => window.cancelAnimationFrame(frame);
  }, [loc, checkVersion]);

  const content = <Fragment key={`${pageKey}#${again}`}>{children}</Fragment>;
  if (!framed) return <PortalFrameContext.Provider value={null}>{content}</PortalFrameContext.Provider>;
  const shown = ready ? page : chromeForPath(pathname);
  return <PortalFrameContext.Provider value={register}>
    <main className={shown?.className || undefined}>
      {shown?.header && <AppShell {...shown.header} />}
      {content}
    </main>
    <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>
  </PortalFrameContext.Provider>;
}
