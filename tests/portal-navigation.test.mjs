// Moving between portal pages without reloading the document (lib/portal-chrome.ts, app/family-village/portal-frame.tsx).
// Which clicks the frame takes over, what the frame shows before a page loads, and a guard against new code that
// sends the browser to an internal page the hard way. The TypeScript is compiled to a temp folder first.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "portal-nav-"));
const source = await readFile(new URL("../lib/portal-chrome.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
await writeFile(path.join(dir, "portal-chrome.mjs"), outputText);
const chrome = await import(pathToFileURL(path.join(dir, "portal-chrome.mjs")).href);
const buildSource = await readFile(new URL("../lib/build-id.ts", import.meta.url), "utf8");
await writeFile(path.join(dir, "build-id.mjs"), ts.transpileModule(buildSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
const build = await import(pathToFileURL(path.join(dir, "build-id.mjs")).href);

const here = { origin: "https://family.example.org", pathname: "/family-village/messages", search: "" };
const click = (href, extra = {}) => ({
  button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
  href: new URL(href, here.origin).href, target: "", download: false, hardNav: false, ...extra,
});

test("an ordinary click on a portal link moves in place", () => {
  assert.equal(chrome.clientHref(click("/family-village/calendar"), here), "/family-village/calendar");
  assert.equal(chrome.clientHref(click("/family-village/admin?tab=people"), here), "/family-village/admin?tab=people");
  assert.equal(chrome.clientHref(click("/family-village/classes/view?id=1#files"), here), "/family-village/classes/view?id=1#files");
  assert.equal(chrome.clientHref(click("/family-village/messages?c=abc"), here), "/family-village/messages?c=abc");
});

test("clicks the browser should handle itself are left alone", () => {
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true },
    { target: "_blank" }, { download: true }, { hardNav: true }]) {
    assert.equal(chrome.clientHref(click("/family-village/calendar", extra), here), null, JSON.stringify(extra));
  }
  assert.equal(chrome.clientHref(click("https://veritasvillage.org/"), here), null, "another site");
  assert.equal(chrome.clientHref(click("/privacy"), here), null, "outside the portal");
  assert.equal(chrome.clientHref(click("/family-village/forms/waiver.pdf"), here), null, "a file");
  assert.equal(chrome.clientHref(click("#thread"), here), null, "a jump within the page");
  assert.equal(chrome.clientHref(click("mailto:office@example.org"), here), null, "mail");
});

test("every page that draws the shared header is known to the frame, with the same class and title", async () => {
  // The frame draws the header before the page has said anything (server render, first paint). If a page's own
  // loading state disagreed, the header would change under the reader the moment the page loaded.
  for (const [pathname, page] of [
    ["/family-village/home", "live-portal"], ["/family-village/documents", "live-portal"], ["/family-village/messages", "workspace-preview messages-page"],
    ["/family-village/calendar", "workspace-preview calendar-page"], ["/family-village/admin", "admin-live"], ["/family-village/teacher/print", "workspace-preview"],
  ]) {
    assert.equal(chrome.chromeForPath(pathname)?.className, page, pathname);
    assert.equal(chrome.chromeForPath(`${pathname}/`)?.className, page, `${pathname}/`);
  }
  assert.equal(chrome.chromeForPath("/family-village/admin").header.current, "admin");
  assert.equal(chrome.chromeForPath("/family-village/teacher/classes").header.title, chrome.CLASSES_HEADERS.teaching.title);
  for (const outside of ["/family-village", "/family-village/accept-invite", "/family-village/preview", "/family-village/native-session", "/privacy"]) {
    assert.equal(chrome.isFramedPath(outside), false, outside);
  }
});

test("every page route under the portal is either framed or deliberately drawn on its own", async () => {
  const root = new URL("../app/family-village/", import.meta.url);
  const pages = (await readdir(root, { recursive: true })).filter((file) => file.endsWith("page.tsx"));
  const own = new Set(["", "/accept-invite", "/preview", "/native-session", "/notifications", "/paperwork"]);
  for (const file of pages) {
    const route = `/${path.dirname(file)}`.replace(/\/\.$/, "").replace(/^\/\.$/, "");
    const pathname = `/family-village${route === "/" ? "" : route}`;
    const key = route === "/" ? "" : route;
    assert.ok(chrome.isFramedPath(pathname) || own.has(key), `${pathname} is neither in the frame's routes (lib/portal-chrome.ts) nor listed as drawn on its own`);
  }
});

test("portal pages do not send the browser to another portal page the hard way", async () => {
  // window.location.assign/href to a portal page reloads the whole document and drops the header, sidebar and
  // bell. Use goTo() from lib/portal-chrome.ts, or a plain <a href> (the frame takes those over). Signing in and
  // signing out are full loads on purpose: they start clean, with nothing from the last person held in memory.
  // The frame itself loads fresh on purpose once a newer build is live (lib/build-id.ts).
  const signIn = new Set(["family-village/sign-in-panel.tsx", "family-village/accept-invite/set-password.tsx", "family-village/portal-frame.tsx"]);
  const root = new URL("../app/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => /\.(tsx|ts)$/.test(file));
  const allowed = /location\.(assign|replace)\("\/family-village(\?deleted=1)?"\)|location\.href = "\/family-village"|location\.replace\("\/family-village\/documents"\)/;
  const problems = [];
  for (const file of files.filter((name) => !signIn.has(name))) {
    const text = await readFile(new URL(file, root), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      const hard = line.match(/location\.(assign|replace)\(([^)]*)\)|location\.href\s*=\s*([^;]+)/);
      if (!hard || allowed.test(line)) continue;
      const target = (hard[2] ?? hard[3] ?? "").trim();
      // Only literal portal paths and the variables that carry one; signed URLs and Stripe links are not pages.
      if (/^["'`]\/family-village/.test(target) || /\b(href|link_path|path)\b/.test(target) && !/signed|url\b/i.test(target)) {
        problems.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(problems, [], "hard navigation to a portal page; use goTo() or a link");
});

test("the portal pages draw their <main> through PortalPage, so the header is not drawn twice", async () => {
  const root = new URL("../app/family-village/", import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".tsx"));
  const drawn = [];
  for (const file of files) {
    const text = await readFile(new URL(file, root), "utf8");
    if (/<AppShell\b/.test(text) && !["portal-frame.tsx", "portal-page.tsx"].includes(file)) drawn.push(`${file} draws <AppShell>`);
  }
  assert.deepEqual(drawn, []);
});

test("a tab left open across a deploy loads fresh on its next move, and only then", () => {
  assert.equal(build.isOutOfDate({ build: "bbb" }, "aaa"), true);
  assert.equal(build.isOutOfDate({ build: "aaa" }, "aaa"), false);
  // Unsure is never out of date: an error page, the password gate's HTML parsed as nothing, a test build.
  for (const answer of [null, "aaa", {}, { build: "" }, { build: "unknown" }, { build: 7 }]) {
    assert.equal(build.isOutOfDate(answer, "aaa"), false, JSON.stringify(answer));
  }
  assert.equal(build.isOutOfDate({ build: "bbb" }, "unknown"), false);
  assert.equal(build.BUILD_ID, "unknown", "outside a Vite build there is no build name");
});

test("the Worker answers /app-version ahead of the password gate", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const answer = worker.indexOf("url.pathname === APP_VERSION_PATH");
  assert.ok(answer > 0 && answer < worker.indexOf("await guardRequest(request, env)"));
});
