// The co-op theme (issue #140): the pre-paint script in the document head must dress the page exactly as the
// functions in lib/coop-theme.ts would, and refuse anything it should not apply; the manifest route puts the
// co-op's name in the installed app's manifest. Contrast is tested in tests/theme-contrast.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "coop-"));
async function load(rel, name) {
  const source = await readFile(new URL(`../${rel}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(dir, `${name}.mjs`), outputText);
  return import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
}
const coop = await load("lib/coop-theme.ts", "coop-theme");
const manifest = await load("worker/manifest.ts", "manifest");

const LOGO = "https://abc.supabase.co/storage/v1/object/public/coop-brand/logo_light/abc.png";

/** Runs the head script with this in storage and returns the custom properties it set. */
function runScript(stored, { throws = false } = {}) {
  const set = {};
  const sandbox = {
    document: { documentElement: { style: { setProperty: (k, v) => { set[k] = v; } } } },
    localStorage: throws ? { getItem() { throw new Error("blocked"); } } : { getItem: () => (stored === undefined ? null : typeof stored === "string" ? stored : JSON.stringify(stored)) },
  };
  vm.runInNewContext(coop.COOP_SCRIPT, sandbox);
  return set;
}

test("with nothing cached, storage blocked or junk cached, the head script leaves the stylesheet's defaults alone", () => {
  assert.deepEqual(runScript(undefined), {});
  assert.deepEqual(runScript(null, { throws: true }), {});
  assert.deepEqual(runScript("{not json"), {});
  assert.deepEqual(runScript({ v: 2, accent: coop.PALETTES[1].tokens }), {});
});

test("the head script sets exactly what themeVars would for a cached theme", () => {
  const theme = coop.parseTheme({ v: 1, name: "Riverbend", accent: coop.PALETTES[2].tokens, font: "book", logos: { logo_light: LOGO, mark_dark: LOGO.replace("logo_light", "mark_dark") }, ratio: 3.1 });
  assert.deepEqual(runScript(theme), coop.themeVars(theme));
  assert.deepEqual(runScript(coop.DEFAULT_THEME), coop.themeVars(coop.DEFAULT_THEME));
});

test("the head script applies an accent whole or not at all, and only safe fonts and logos", () => {
  const half = { ...coop.PALETTES[1].tokens, night_fill: "red" };
  const got = runScript({ v: 1, accent: half, font: "comic", logos: { logo_light: "https://evil.example/x.png", logo_dark: `${LOGO}");background:url("x` }, ratio: 40 });
  assert.deepEqual(got, {}, "nothing from a bad cache is applied");
});

test("themeVars only names properties the stylesheet reads", async () => {
  const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8")) + (await readFile(new URL("../app/theme.css", import.meta.url), "utf8"));
  for (const name of coop.THEME_VAR_NAMES) assert.ok(css.includes(`var(${name})`), `${name} is used somewhere`);
});

test("the manifest takes the co-op's name, and keeps the template otherwise", () => {
  const template = { name: "Veritas Village Family Portal", short_name: "Veritas Village", description: "Classes, news, and reminders for Veritas Village families and teachers.", icons: [1] };
  assert.equal(manifest.brandManifest(template, null), template);
  assert.equal(manifest.brandManifest(template, "Veritas Village"), template);
  assert.deepEqual(manifest.brandManifest(template, " Riverbend Co-op "), {
    name: "Riverbend Co-op Family Portal", short_name: "Riverbend Co-op",
    description: "Classes, news, and reminders for Riverbend Co-op families and teachers.", icons: [1],
  });
});

test("the manifest route serves the template when the settings cannot be read, and the branded copy when they can", async () => {
  const template = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  const assets = { fetch: async (req) => { assert.equal(new URL(req.url).pathname, "/manifest.webmanifest"); return new Response(JSON.stringify(template)); } };
  const supabase = { url: "https://abc.supabase.co", key: "pk" };
  const request = new Request("https://family.example.org/app.webmanifest");

  const down = await manifest.handleManifest(request, assets, supabase, async () => { throw new Error("offline"); });
  assert.deepEqual(await down.json(), template);
  assert.equal(down.headers.get("content-type"), "application/manifest+json");

  let asked = "";
  const up = await manifest.handleManifest(request, assets, supabase, async (url, init) => {
    asked = String(url);
    assert.equal(init.headers.apikey, "pk");
    return new Response(JSON.stringify([{ name: "Riverbend Co-op" }]));
  });
  assert.equal(asked, "https://abc.supabase.co/rest/v1/coop_settings?select=name&id=eq.coop");
  const body = await up.json();
  assert.equal(body.short_name, "Riverbend Co-op");
  assert.deepEqual(body.icons, template.icons);
  assert.equal(body.start_url, template.start_url);
});
