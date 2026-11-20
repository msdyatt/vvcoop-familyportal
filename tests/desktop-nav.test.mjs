// The desktop navigation (lib/desktop-nav.ts): one home and one name for every page, Admin as a mode, and a
// sidebar that never reaches the installed apps. The TypeScript is compiled to a temp folder first.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "desktop-nav-"));
for (const name of ["desktop-nav", "nav-prefs"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(dir, `${name}.mjs`), outputText);
}
const nav = await import(pathToFileURL(path.join(dir, "desktop-nav.mjs")).href);
const prefs = await import(pathToFileURL(path.join(dir, "nav-prefs.mjs")).href);
const FV = "/family-village";

test("every Admin tab belongs to exactly one sidebar group", async () => {
  const workspace = await readFile(new URL("../app/family-village/admin/workspace.tsx", import.meta.url), "utf8");
  const tabs = JSON.parse(workspace.match(/const TABS = (\[[^\]]*\])/)[1]);
  const grouped = nav.ADMIN_GROUPS.flatMap((group) => group.tabs.map((tab) => tab.id));
  assert.deepEqual([...grouped].sort(), [...tabs].sort());
  assert.equal(new Set(grouped).size, grouped.length, "a tab is in two groups");
  assert.equal(nav.ADMIN_GROUPS.length, 7);
});

test("the address picks the Admin tab and its group; old Compliance links land on Documents", () => {
  assert.equal(nav.adminTabFrom(""), "dashboard");
  assert.equal(nav.adminTabFrom("?tab=invitations"), "invitations");
  assert.equal(nav.adminGroupOf("invitations").id, "people");
  assert.equal(nav.adminTabFrom("?tab=compliance"), "documents");
  assert.equal(nav.adminTabFrom("?tab=nonsense"), "dashboard");
  assert.equal(nav.adminHref("dashboard"), `${FV}/admin`);
  assert.equal(nav.adminHref("dues"), `${FV}/admin?tab=dues`);
});

test("every signed-in portal page has one place in the sidebar", async () => {
  const pages = [];
  const walk = async (folder, rel) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), `${rel}/${entry.name}`);
      else if (entry.name === "page.tsx") pages.push(rel);
    }
  };
  const root = new URL("../app/family-village/", import.meta.url).pathname;
  await walk(root, FV);
  // Outside the sidebar on purpose: sign-in, invitations, the native sign-in bridge, the public preview,
  // the bell's own page, and Admin (which is a mode of its own).
  const outside = ["", "/accept-invite", "/native-session", "/preview", "/notifications", "/admin"].map((p) => `${FV}${p}`);
  for (const page of pages.filter((p) => !outside.includes(p))) {
    assert.ok(nav.activePortalItem(page), `${page} has no place in the sidebar`);
  }
  assert.equal(nav.activePortalItem(`${FV}/home/`), "today");
  assert.equal(nav.activePortalItem(`${FV}/teacher/print`), "classes");
  assert.equal(nav.activePortalItem(`${FV}/dues`), "family");
  assert.equal(nav.activePortalItem(`${FV}/notifications`), null);
});

test("Family pages share a tab strip; Classes gets one only for people who teach", () => {
  assert.equal(nav.areaFor(`${FV}/documents`, false).active, "documents");
  assert.equal(nav.areaFor(`${FV}/paperwork`, false).active, "documents");
  assert.equal(nav.areaFor(`${FV}/classes`, false), null);
  assert.equal(nav.areaFor(`${FV}/classes`, true).active, "classes-children");
  assert.equal(nav.areaFor(`${FV}/teacher`, true).active, "classes-teaching");
  assert.equal(nav.areaFor(`${FV}/teacher/print`, true).active, "print-queue");
  assert.equal(nav.areaFor(`${FV}/classes/view`, true), null);
  assert.equal(nav.areaFor(`${FV}/home`, true), null);
});

test("Jump to finds pages by name and by everyday words, and shows Admin only to admins", () => {
  const parent = nav.jumpEntries(["parent"]);
  const first = (entries, q) => nav.searchJump(entries, q)[0];
  assert.equal(first(parent, "dues").href, `${FV}/dues`);
  assert.equal(first(parent, "waiver").href, `${FV}/documents`);
  assert.equal(first(parent, "pay").href, `${FV}/dues`);
  assert.equal(first(parent, "pho").href, `${FV}/photos`);
  assert.equal(nav.searchJump(parent, "print").length, 0, "a parent who does not teach has no print queue");
  assert.ok(!parent.some((entry) => entry.adminTab), "no Admin pages for a parent");
  assert.equal(nav.searchJump(parent, "zzzz").length, 0);
  assert.deepEqual(nav.searchJump(parent, "").map((e) => e.id), ["today", "messages", "calendar", "classes", "family", "photos", "news"]);

  const teacher = nav.jumpEntries(["parent", "teacher"]);
  assert.equal(first(teacher, "print").href, `${FV}/teacher/print`);

  const admin = nav.jumpEntries(["parent", "admin"]);
  // The family's own Dues comes before the Admin one.
  const dues = nav.searchJump(admin, "dues");
  assert.equal(dues[0].href, `${FV}/dues`);
  assert.equal(dues[1].href, `${FV}/admin?tab=dues`);
  assert.equal(dues[1].trail, "Admin › Money");
  assert.equal(first(admin, "invite").adminTab, "invitations");
});

test("the phone Menu uses the same names as the desktop", () => {
  const label = (id) => prefs.destination(id).label;
  const desktop = (tab) => nav.ADMIN_GROUPS.flatMap((g) => g.tabs).find((t) => t.id === tab).label;
  for (const [id, tab] of [["admin-dashboard", "dashboard"], ["admin-invitations", "invitations"], ["admin-flagged", "message-reports"], ["admin-integrations", "integrations"], ["admin-families", "families"], ["admin-documents", "documents"], ["admin-reports", "reports"], ["admin-activity", "activity"]]) {
    assert.equal(label(id), desktop(tab), id);
  }
});

test("greetings and seasons follow the clock", () => {
  assert.equal(nav.greeting(nav.dayPartOf(new Date(2026, 10, 20, 8)), "Dana"), "Good morning, Dana");
  assert.equal(nav.greeting(nav.dayPartOf(new Date(2026, 10, 20, 14)), ""), "Good afternoon");
  assert.equal(nav.dayPartOf(new Date(2026, 10, 20, 23)), "night");
  assert.equal(nav.seasonOf(new Date(2026, 10, 20)), "autumn");
  assert.equal(nav.seasonOf(new Date(2026, 11, 2)), "winter");
  assert.equal(nav.seasonOf(new Date(2027, 3, 2)), "spring");
  assert.equal(nav.seasonOf(new Date(2027, 6, 2)), "summer");
});

test("a tucked-away sidebar is marked before the first paint, and a broken storage does not throw", () => {
  const run = (stored, throws = false) => {
    const dataset = {};
    vm.runInNewContext(nav.SIDENAV_SCRIPT, {
      document: { documentElement: { dataset } },
      localStorage: { getItem: () => { if (throws) throw new Error("blocked"); return stored; } },
    });
    return dataset.sidenav;
  };
  assert.equal(run("collapsed"), "collapsed");
  assert.equal(run("open"), undefined);
  assert.equal(run(null, true), undefined);
});

test("the sidebar, its drawer, the tab strips and the header buttons only show in a browser, never in the installed apps", async () => {
  const css = (await readFile(new URL("../app/desktop-nav.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /^\.side-nav,\s*\.area-tabs,\s*\.jump-to-trigger\s*\{\s*display:none;\s*\}/m);
  const showing = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, selector, body]) => /(^|[\s,])\.(side-nav|side-nav-scrim|side-nav-close|area-tabs|jump-to-trigger|mobile-nav-trigger)(\s*[,{]|$)/m.test(selector.trim() + "{") && /display\s*:\s*(flex|inline-flex|grid|block)/.test(body))
    .map(([, selector]) => selector.trim());
  assert.ok(showing.length >= 6, showing.join("\n"));
  assert.match(css, /^\.mobile-nav-trigger,\s*\.side-nav-close,\s*\.side-nav-scrim\s*\{\s*display:none;\s*\}/m);
  for (const selector of showing) assert.match(selector, /html:not\(\[data-app\]\):not\(\[data-frame\]\)/, selector);
  assert.match(css, /@media \(min-width:1024px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});
