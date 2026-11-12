// Light / Dark / System: the resolver, the device/account rule, storage that may be missing, and the pre-paint
// script in the document head, which must make the same decisions as the functions (lib/theme.ts).
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "theme-"));
for (const name of ["nav-prefs", "native-frame", "theme"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(dir, `${name}.mjs`), outputText.replaceAll('"./nav-prefs"', '"./nav-prefs.mjs"').replaceAll('"./native-frame"', '"./native-frame.mjs"'));
}
const theme = await import(pathToFileURL(path.join(dir, "theme.mjs")).href);
const nav = await import(pathToFileURL(path.join(dir, "nav-prefs.mjs")).href);

const fakeStorage = (value) => ({ getItem: () => value, setItem: () => {} });
const throwingStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("a chosen theme is used as chosen, and System follows the device", () => {
  assert.equal(theme.resolveTheme("light", true), "light");
  assert.equal(theme.resolveTheme("dark", false), "dark");
  assert.equal(theme.resolveTheme("system", true), "dark");
  assert.equal(theme.resolveTheme("system", false), "light");
});

test("anything that is not a known choice means System", () => {
  for (const junk of [undefined, null, "", "Dark", "auto", 3, {}, []]) assert.equal(theme.parseChoice(junk), "system");
  for (const ok of ["light", "dark", "system"]) assert.equal(theme.parseChoice(ok), ok);
});

test("the device's own choice wins; a device never set takes the account's; neither follows the device", () => {
  assert.equal(theme.chooseTheme("dark", "light"), "dark");
  assert.equal(theme.chooseTheme(null, "dark"), "dark");
  assert.equal(theme.chooseTheme(undefined, "light"), "light");
  assert.equal(theme.chooseTheme("junk", "junk"), "system");
  assert.equal(theme.chooseTheme(null, null), "system");
});

test("stored choice: read when there, null when missing, junk or storage unavailable", () => {
  assert.equal(theme.readStoredChoice(fakeStorage("dark")), "dark");
  assert.equal(theme.readStoredChoice(fakeStorage(null)), null);
  assert.equal(theme.readStoredChoice(fakeStorage("purple")), null);
  assert.equal(theme.readStoredChoice(throwingStorage), null);
  assert.equal(theme.readStoredChoice(null), null);
});

test("storing reports whether the device kept it, and never throws", () => {
  const kept = [];
  assert.equal(theme.storeChoice("dark", { getItem: () => null, setItem: (k, v) => kept.push([k, v]) }), true);
  assert.deepEqual(kept, [["vv-theme", "dark"]]);
  assert.equal(theme.storeChoice("dark", throwingStorage), false);
  assert.equal(theme.storeChoice("dark", null), false);
});

test("the choice rides along in the person's saved record and junk is dropped", () => {
  assert.equal(nav.cleanPrefs({ theme: "dark", home: ["home"] }).theme, "dark");
  assert.equal("theme" in nav.cleanPrefs({ theme: "mauve" }), false);
  assert.equal("theme" in nav.cleanPrefs({}), false);
});

/** Runs the head script against a fake page and returns what it did to it. */
function runScript({ stored, systemDark, storageThrows = false, noMatchMedia = false }) {
  const metas = [
    { attrs: { name: "theme-color", media: "(prefers-color-scheme: light)", content: "x" } },
    { attrs: { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "x" } },
  ].map((m) => ({ getAttribute: (k) => m.attrs[k] ?? null, setAttribute: (k, v) => { m.attrs[k] = v; }, attrs: m.attrs }));
  const root = { dataset: {}, style: {} };
  const sandbox = {
    document: { documentElement: root, querySelectorAll: () => metas },
    localStorage: storageThrows ? { getItem() { throw new Error("blocked"); } } : { getItem: () => stored },
  };
  if (!noMatchMedia) sandbox.matchMedia = () => ({ matches: systemDark });
  vm.runInNewContext(theme.THEME_SCRIPT, sandbox);
  return { theme: root.dataset.theme, choice: root.dataset.themeChoice, colorScheme: root.style.colorScheme, metas: metas.map((m) => m.attrs.content) };
}

test("the head script makes the same decision as the functions, for every stored value and device setting", () => {
  for (const stored of [null, "system", "light", "dark", "junk"]) {
    for (const systemDark of [false, true]) {
      const choice = theme.parseChoice(stored);
      const expected = theme.resolveTheme(choice, systemDark);
      const got = runScript({ stored, systemDark });
      assert.equal(got.theme, expected, `stored=${stored} systemDark=${systemDark}`);
      assert.equal(got.choice, choice);
      assert.equal(got.colorScheme, expected);
    }
  }
});

test("the head script colours the browser bar: per scheme for System, the chosen colour otherwise", () => {
  const { light, dark } = theme.THEME_COLORS;
  assert.deepEqual(runScript({ stored: null, systemDark: true }).metas, [light, dark]);
  assert.deepEqual(runScript({ stored: "dark", systemDark: false }).metas, [dark, dark]);
  assert.deepEqual(runScript({ stored: "light", systemDark: true }).metas, [light, light]);
});

test("with storage blocked the page follows the device, and with nothing at all it still does not throw", () => {
  assert.equal(runScript({ stored: null, systemDark: true, storageThrows: true }).theme, "dark");
  assert.equal(runScript({ stored: null, systemDark: false, storageThrows: true }).theme, "light");
  assert.doesNotThrow(() => runScript({ stored: "dark", systemDark: true, noMatchMedia: true }));
  assert.equal(runScript({ stored: "dark", systemDark: false, noMatchMedia: true }).theme, "dark");
});
