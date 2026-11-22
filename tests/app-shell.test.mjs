// The installed web app's tab bar: which launches get it, and that nothing in the stylesheet can hide it by accident.
// The platform script in lib/platform.ts decides it before first paint, so it is exercised here exactly as shipped.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../lib/platform.ts", import.meta.url), "utf8");
const script = Function(`return \`${source.match(/PLATFORM_SCRIPT = `([\s\S]*?)`;/)[1]}\``)();

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1";
const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";

function launch({ ua, platform, touch = 0, displayMode = false, standalone, frame }) {
  const dataset = {};
  const context = {
    document: { documentElement: { dataset } },
    navigator: { userAgent: ua, platform, maxTouchPoints: touch, standalone },
    matchMedia: () => ({ matches: displayMode }),
  };
  context.window = frame ? Object.assign(context, { VVNative: { frame: true, platform: "ios" } }) : context;
  vm.runInNewContext(script, context);
  return dataset;
}

test("iPhone and iPad home-screen apps, and Android installed apps, get the tab bar", () => {
  assert.equal(launch({ ua: IPHONE, platform: "iPhone", touch: 5, displayMode: true, standalone: true }).app, "1");
  assert.equal(launch({ ua: MAC_SAFARI, platform: "MacIntel", touch: 5, displayMode: true, standalone: true }).app, "1", "iPad reports a Mac user agent");
  const android = launch({ ua: ANDROID, platform: "Linux armv81", touch: 5, displayMode: true });
  assert.equal(android.app, "1");
  assert.equal(android.platform, "android");
});

test("the iPhone app's frame is marked, so the web bar steps aside for the native one", () => {
  const dataset = launch({ ua: IPHONE, platform: "iPhone", touch: 5, frame: true });
  assert.equal(dataset.frame, "ios");
  assert.equal(dataset.app, "1");
});

test("ordinary browser tabs and desktop-installed windows get no bottom bar (they keep the header navigation)", () => {
  assert.equal(launch({ ua: IPHONE, platform: "iPhone", touch: 5 }).app, undefined);
  assert.equal(launch({ ua: ANDROID, platform: "Linux armv81", touch: 5 }).app, undefined);
  assert.equal(launch({ ua: MAC_CHROME, platform: "MacIntel", displayMode: true }).app, undefined);
});

test("the stylesheet shows the bar in the installed apps and hides it only for the frame and the on-screen keyboard", async () => {
  const css = (await readFile(new URL("../app/platform.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const hiding = [...css.matchAll(/([^{}]*\.app-tabbar[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , body]) => /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0\b/.test(body))
    .map(([, selector]) => selector.trim().replace(/\s+/g, " "));
  assert.deepEqual(hiding.sort(), [".app-tabbar", "html[data-app][data-kb] .app-tabbar", "html[data-frame] .app-tabbar"].sort());
  assert.match(css, /html\[data-app\] \.app-tabbar\s*\{[^}]*display:\s*flex/);
});

// ---- Messages on a desktop browser (app/messages-desktop.css) ----
// Messages on a desktop browser fills the content area (app/messages-desktop.css). The phone, the installed web app
// and the native apps keep their own Messages layout, so every rule here must stay inside the desktop media query
// and skip html[data-app] and html[data-frame]; and the file must load last to win over globals.css.

const messagesCss = await readFile(new URL("../app/messages-desktop.css", import.meta.url), "utf8");
const rootLayout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const messagesBody = messagesCss.replace(/\/\*[\s\S]*?\*\//g, "");

test("every rule is for desktop browsers only", () => {
  const open = messagesBody.indexOf("@media (min-width:1024px)");
  assert.ok(open >= 0, "the desktop media query is missing");
  assert.equal(messagesBody.slice(0, open).trim(), "", "a rule sits outside the desktop media query");
  const inner = messagesBody.slice(messagesBody.indexOf("{", open) + 1, messagesBody.lastIndexOf("}"));
  const selectors = [...inner.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.ok(selectors.length > 5);
  for (const selector of selectors) {
    assert.ok(selector.startsWith("html:not([data-app]):not([data-frame]) main.messages-page:has(> .side-nav-shell)"), selector);
  }
});

test("the stylesheet loads after globals.css and the other layout sheets", () => {
  const imports = [...rootLayout.matchAll(/^import "\.\/([^"]+\.css)";$/gm)].map((m) => m[1]);
  assert.equal(imports.at(-1), "messages-desktop.css");
});

test("no raw colours: role tokens only", () => {
  assert.doesNotMatch(messagesBody, /#[0-9a-f]{3,8}\b|rgb\(\s*\d/i);
});
