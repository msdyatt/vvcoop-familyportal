// Messages on a desktop browser fills the content area (app/messages-desktop.css). The phone, the installed web app
// and the native apps keep their own Messages layout, so every rule here must stay inside the desktop media query
// and skip html[data-app] and html[data-frame]; and the file must load last to win over globals.css.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/messages-desktop.css", import.meta.url), "utf8");
const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("every rule is for desktop browsers only", () => {
  const open = body.indexOf("@media (min-width:1024px)");
  assert.ok(open >= 0, "the desktop media query is missing");
  assert.equal(body.slice(0, open).trim(), "", "a rule sits outside the desktop media query");
  const inner = body.slice(body.indexOf("{", open) + 1, body.lastIndexOf("}"));
  const selectors = [...inner.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.ok(selectors.length > 5);
  for (const selector of selectors) {
    assert.ok(selector.startsWith("html:not([data-app]):not([data-frame]) main.messages-page:has(> .side-nav-shell)"), selector);
  }
});

test("the stylesheet loads after globals.css and the other layout sheets", () => {
  const imports = [...layout.matchAll(/^import "\.\/([^"]+\.css)";$/gm)].map((m) => m[1]);
  assert.equal(imports.at(-1), "messages-desktop.css");
});

test("no raw colours: role tokens only", () => {
  assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgb\(\s*\d/i);
});
