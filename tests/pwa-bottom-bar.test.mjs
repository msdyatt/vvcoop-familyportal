// The installed web app's bottom bar must survive hydration (issue #111).
//
// The bar shows only under html[data-app], which the head script sets (lib/platform.ts). If the browser's first
// render of a signed-in page differs from the server's HTML, React rebuilds the whole document and its <html>
// singleton drops every attribute it did not render itself, data-app included, so the bar disappears. That happened
// to anyone whose device had a saved, non-default bar or a cached "teaches" flag, because the shell read device
// storage during its first render. These tests check both halves of the fix:
//   1. the shell's first render in a browser with that device storage is the server's HTML, byte for byte, so
//      hydration has nothing to rebuild; and
//   2. if <html> loses the flags anyway (any other mismatch), PlatformSync puts them back, using the same
//      detection as the head script.
// The shell is bundled with rolldown (already used by the build); the database client and the router are stubbed.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { rolldown } from "rolldown";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), "pwa-bottom-bar-"));

const STUBS = {
  // No network: nothing in these tests may reach Supabase.
  supabase: `export const getSupabaseBrowserClient = () => null; export const isSupabaseConfigured = () => false;
    export const supabaseConnection = () => ({ url: "", key: "" }); export const edgeFunctionUrl = (name) => "/" + name;
    export const functionErrorMessage = async (_e, _d, fallback) => fallback;`,
  navigation: `export const usePathname = () => globalThis.__path; export const useSearchParams = () => new URLSearchParams();
    export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} });`,
  link: `import { createElement } from "react"; export default function Link({ href, children, prefetch, ...rest }) { return createElement("a", { href, ...rest }, children); }`,
};
for (const [name, source] of Object.entries(STUBS)) await writeFile(path.join(dir, `${name}.mjs`), source);

await writeFile(path.join(dir, "entry.tsx"), `
  export { AppShell } from ${JSON.stringify(path.join(root, "app/family-village/app-header.tsx"))};
  export { restorePlatformFlags, detectPlatformFlags, PLATFORM_SCRIPT } from ${JSON.stringify(path.join(root, "lib/platform.ts"))};
`);

const bundle = await rolldown({
  input: path.join(dir, "entry.tsx"),
  platform: "node",
  logLevel: "silent",
  external: [/^react($|\/)/, /^react-dom($|\/)/],
  transform: { jsx: "react-jsx", define: { "process.env.NODE_ENV": '"production"' } },
  moduleTypes: { ".css": "empty", ".svg": "empty", ".png": "empty" },
  plugins: [{
    name: "stubs",
    resolveId(id) {
      if (id === "next/navigation") return path.join(dir, "navigation.mjs");
      if (id === "next/link") return path.join(dir, "link.mjs");
      if (/(^|\/)lib\/supabase(\.ts)?$/.test(id)) return path.join(dir, "supabase.mjs");
      return null;
    },
  }],
});
await bundle.write({ file: path.join(dir, "shell.mjs"), format: "esm" });
// The bundle sits outside the project, so give it the project's React.
const shellSource = (await readFile(path.join(dir, "shell.mjs"), "utf8"))
  .replace(/from "(react(?:-dom)?(?:\/[\w./-]+)?)"/g, (_, id) => `from ${JSON.stringify(pathToFileURL(path.join(root, "node_modules", id === "react" || id === "react-dom" ? `${id}/index.js` : `${id}.js`)).href)}`);
await writeFile(path.join(dir, "shell.mjs"), shellSource);
const shell = await import(pathToFileURL(path.join(dir, "shell.mjs")).href);
const { createElement } = await import("react");
const { renderToString } = await import("react-dom/server");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";

/** A browser just far enough for the shell's first render: an address, device storage and media queries. */
function fakeBrowser(pathname, stored) {
  const store = new Map(Object.entries(stored));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const listeners = { addEventListener() {}, removeEventListener() {} };
  const document = { ...listeners, documentElement: { dataset: {}, style: { getPropertyValue: () => "", setProperty() {} } }, visibilityState: "visible", activeElement: null };
  return { ...listeners, location: { pathname, hash: "", search: "" }, localStorage, document, matchMedia: () => ({ matches: true, ...listeners }), navigator: { userAgent: IPHONE, platform: "iPhone", maxTouchPoints: 5, standalone: true } };
}

function render(props, browser) {
  globalThis.__path = props.path;
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  if (browser) Object.assign(globalThis, { window: browser, document: browser.document, localStorage: browser.localStorage });
  try {
    return renderToString(createElement(shell.AppShell, { current: props.current, roles: props.roles, title: props.title }));
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
}

// A person who customised their bar, who teaches, and who was last in Admin.
const DEVICE = {
  "vv-nav-prefs": JSON.stringify({ home: ["home", "calendar", "news", "documents", "messages"], admin: ["admin-dashboard", "admin-families"] }),
  "vv-last-section": "admin",
  "vv-teaches": "1",
};

test("the device's storage keys are the ones lib/nav-prefs.ts reads", async () => {
  const source = await readFile(new URL("../lib/nav-prefs.ts", import.meta.url), "utf8");
  for (const key of Object.keys(DEVICE)) assert.ok(source.includes(`"${key}"`), `lib/nav-prefs.ts no longer uses ${key}; update DEVICE`);
});

for (const page of [
  { current: "home", path: "/family-village/home", roles: ["parent"], title: "Home" },
  { current: "messages", path: "/family-village/messages", roles: ["parent", "admin"], title: "Messages" },
  { current: "admin", path: "/family-village/admin", roles: ["admin"], title: "Admin" },
]) {
  test(`a saved, non-default bar hydrates without a mismatch on ${page.path}, so <html> keeps data-app`, () => {
    const server = render(page);
    const client = render(page, fakeBrowser(page.path, DEVICE));
    assert.ok(server.includes('class="app-tabbar'), "the bar is rendered");
    assert.equal(client, server, "the first render in the browser differs from the server's HTML: React would rebuild <html> and drop data-app");
  });
}

// ---- PlatformSync: put the flags back if <html> loses them anyway ----

function launch({ ua, platform, touch = 0, displayMode = false, standalone, frame, capacitor }) {
  const win = { navigator: { userAgent: ua, platform, maxTouchPoints: touch, standalone }, matchMedia: () => ({ matches: displayMode }) };
  if (frame) win.VVNative = { frame: true, platform: "ios" };
  if (capacitor) win.Capacitor = { isNativePlatform: () => true, getPlatform: () => capacitor };
  return win;
}

const LAUNCHES = {
  "iPhone home screen": launch({ ua: IPHONE, platform: "iPhone", touch: 5, displayMode: true, standalone: true }),
  "iPhone Safari tab": launch({ ua: IPHONE, platform: "iPhone", touch: 5 }),
  "iPhone frame": launch({ ua: IPHONE, platform: "iPhone", touch: 5, frame: true }),
  "Android app": launch({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile", platform: "Linux armv81", touch: 5, capacitor: "android" }),
  "Android installed": launch({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0.0.0 Mobile", platform: "Linux armv81", touch: 5, displayMode: true }),
  "iPad home screen": launch({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15", platform: "MacIntel", touch: 5, displayMode: true }),
  "desktop installed": launch({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0", platform: "MacIntel", displayMode: true }),
};

test("the guard's detection gives the same answer as the head script for every kind of launch", () => {
  for (const [name, win] of Object.entries(LAUNCHES)) {
    const dataset = {};
    vm.runInNewContext(shell.PLATFORM_SCRIPT, { ...win, window: win, document: { documentElement: { dataset } } });
    assert.deepEqual({ ...shell.detectPlatformFlags(win) }, { ...dataset }, name);
  }
});

test("after React strips <html>, the flags come back, and nothing is added that the head script would not set", () => {
  for (const [name, win] of Object.entries(LAUNCHES)) {
    const expected = {};
    vm.runInNewContext(shell.PLATFORM_SCRIPT, { ...win, window: win, document: { documentElement: { dataset: expected } } });
    const html = { dataset: { ...expected } };
    for (const key of Object.keys(html.dataset)) delete html.dataset[key]; // what commitHostSingletonAcquisition does
    assert.equal(shell.restorePlatformFlags(html, win), true, name);
    assert.deepEqual(html.dataset, expected, name);
    assert.equal(shell.restorePlatformFlags(html, win), false, `${name}: a second pass changes nothing, so the observer cannot loop`);
  }
  const homeScreen = { dataset: {} };
  shell.restorePlatformFlags(homeScreen, LAUNCHES["iPhone home screen"]);
  assert.equal(homeScreen.dataset.app, "1", "the iPhone home-screen app gets its bar back");
});

test("the root layout mounts PlatformSync and tells older iPhones the site is a home-screen app", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<PlatformSync \/>/);
  assert.match(layout, /"apple-mobile-web-app-capable": "yes"/);
  const sync = await readFile(new URL("../app/platform-sync.tsx", import.meta.url), "utf8");
  assert.match(sync, /restorePlatformFlags\(root\);\s*\n\s*const guard = new MutationObserver/, "it checks once on mount, not only on later changes");
});
