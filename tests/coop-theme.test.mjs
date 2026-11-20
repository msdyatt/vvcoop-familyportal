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

/** Runs the head script with this in storage and returns the custom properties it set (and the page's dataset). */
function runScript(stored, { throws = false, personal = null, textSize = null, dataset = {}, now = null } = {}) {
  const set = {};
  const values = {
    [coop.COOP_THEME_KEY]: stored === undefined ? null : typeof stored === "string" ? stored : JSON.stringify(stored),
    [coop.PERSONAL_ACCENT_KEY]: personal,
    [coop.TEXT_SIZE_KEY]: textSize,
  };
  const sandbox = {
    document: { documentElement: { dataset, style: { setProperty: (k, v) => { set[k] = v; } } } },
    localStorage: throws ? { getItem() { throw new Error("blocked"); } } : { getItem: (k) => values[k] ?? null },
  };
  // A fixed "now" for the seasonal logos: `new Date()` with no argument gives it.
  if (now) sandbox.Date = class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return Date.parse(now); } };
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

// ---- Personal appearance (part 2) ----------------------------------------------------------------------------------

test("the head script wears the person's palette only when the co-op allows it", () => {
  const theme = coop.parseTheme({ v: 1, name: "Riverbend", accent: coop.PALETTES[0].tokens, personalPalettes: ["teal", "plum"] });
  const teal = coop.PALETTES.find((p) => p.id === "teal").tokens;
  assert.deepEqual(runScript(theme, { personal: "teal" }), coop.themeVars({ ...theme, accent: coop.effectiveAccent(theme, "teal") }));
  assert.equal(runScript(theme, { personal: "teal" })["--terracotta"], teal.accent);
  assert.equal(runScript(theme, { personal: "ochre" })["--terracotta"], theme.accent.accent, "a palette the co-op does not offer is ignored");
  assert.equal(runScript(theme, { personal: "coop" })["--terracotta"], theme.accent.accent);
  assert.equal(runScript({ ...theme, personalPalettes: "teal" }, { personal: "teal" })["--terracotta"], theme.accent.accent, "a malformed list offers nothing");
  assert.deepEqual(coop.effectiveAccent(theme, "teal"), teal);
  assert.deepEqual(coop.effectiveAccent(theme, "ochre"), theme.accent);
  assert.deepEqual(coop.effectiveAccent({ ...theme, personalPalettes: [] }, "teal"), theme.accent);
});

test("the head script turns on larger text from the device, even before the co-op settings are cached", () => {
  const dataset = {};
  runScript(undefined, { textSize: "large", dataset });
  assert.equal(dataset.textSize, "large");
  const plain = {};
  runScript(undefined, { textSize: "huge", dataset: plain });
  assert.equal(plain.textSize, undefined);
});

test("a cached theme keeps the co-op's list of personal palettes, without unknown ones", () => {
  assert.deepEqual(coop.parseTheme({ v: 1, personalPalettes: ["teal", "neon", 3] }).personalPalettes, ["teal"]);
  assert.deepEqual(coop.parseTheme({ v: 1 }).personalPalettes, coop.PALETTES.map((p) => p.id));
});

test("the database offers exactly the ready-made palettes", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261120100000_personal_palettes.sql", import.meta.url), "utf8");
  const ids = coop.PALETTES.map((p) => p.id);
  assert.ok(sql.includes(`default '{${ids.join(",")}}'`), "the column default");
  assert.equal(sql.split(`array['${ids.join("', '")}']`).length - 1, 2, "the column check and the function's list");
});

// ---- Seasonal logos (part 3) -----------------------------------------------------------------------------------------

const base = "https://abc.supabase.co/storage/v1/object/public/coop-brand/";
const variant = (name, startsOn, endsOn, extra = {}) => ({
  name, startsOn, endsOn, yearly: false, override: "auto", ratio: null, updatedAt: "2026-01-01T00:00:00Z",
  logos: { logo_light: `${base}seasonal/${name}.png` }, ...extra,
});

test("the variant in force: turned on first, then the shortest dated range that holds today, then the newest", () => {
  const harvest = variant("harvest", "2026-10-01", "2026-10-31");
  const founders = variant("founders", "2026-10-12", "2026-10-12");
  const winter = variant("winter", "2026-12-15", "2027-01-06", { yearly: true });
  const off = variant("off", "2026-01-01", "2026-12-31", { override: "off" });
  const all = [harvest, founders, winter, off];
  assert.equal(coop.activeVariant(all, "2026-10-05")?.name, "harvest");
  assert.equal(coop.activeVariant(all, "2026-10-12")?.name, "founders", "a one-day range beats a month");
  assert.equal(coop.activeVariant(all, "2026-11-01"), null, "nothing in November: the co-op's own logo");
  assert.equal(coop.activeVariant(all, "2027-12-20")?.name, "winter", "yearly ranges ignore the year");
  assert.equal(coop.activeVariant(all, "2028-01-03")?.name, "winter", "and may run over New Year");
  assert.equal(coop.activeVariant(all, "2028-01-07"), null);
  assert.equal(coop.activeVariant([off], "2026-06-01"), null, "'off' never shows");
  const onOld = variant("on-old", "2020-01-01", "2020-01-02", { override: "on", updatedAt: "2026-01-01T00:00:00Z" });
  const onNew = variant("on-new", "2020-01-01", "2020-01-02", { override: "on", updatedAt: "2026-02-01T00:00:00Z" });
  assert.equal(coop.activeVariant([...all, onOld, onNew], "2026-10-12")?.name, "on-new", "turned on wins, the newest of them");
  const twin = variant("twin", "2026-10-01", "2026-10-31", { updatedAt: "2026-03-01T00:00:00Z" });
  assert.equal(coop.activeVariant([harvest, twin], "2026-10-05")?.name, "twin", "same length: the newest");
});

test("today is the co-op's date, not the computer's", () => {
  assert.equal(coop.coopToday("America/Chicago", new Date("2026-11-20T04:00:00Z")), "2026-11-19");
  assert.equal(coop.coopToday("UTC", new Date("2026-11-20T04:00:00Z")), "2026-11-20");
  assert.equal(coop.coopToday("Not/AZone", new Date("2026-11-20T04:00:00Z")), "2026-11-20");
});

test("a variant replaces only the slots it has, with its own shape; the head script does the same on every day", () => {
  const theme = coop.parseTheme({
    v: 1, name: "Riverbend", timeZone: "UTC", ratio: 2.9,
    logos: { logo_light: `${base}logo_light/a.png`, mark_light: `${base}mark_light/m.png` },
    seasonal: [
      variant("harvest", "2026-10-01", "2026-10-31", { ratio: 4, logos: { logo_light: `${base}seasonal/h.png`, mark_dark: `${base}seasonal/hm.png` } }),
      variant("winter", "2026-12-15", "2027-01-06", { yearly: true, logos: { logo_dark: `${base}seasonal/w.png` } }),
      { junk: true },
    ],
  });
  assert.equal(theme.seasonal.length, 2, "a malformed variant is dropped");
  const oct = coop.themeVars(theme, "2026-10-10");
  assert.equal(oct["--coop-lockup-light"], `url("${base}seasonal/h.png")`);
  assert.equal(oct["--coop-mark-light"], `url("${base}mark_light/m.png")`, "the co-op's own mark stays");
  assert.equal(oct["--coop-mark-dark"], `url("${base}seasonal/hm.png")`);
  assert.equal(oct["--coop-lockup-ratio"], "4");
  const jan = coop.themeVars(theme, "2027-01-02");
  assert.equal(jan["--coop-lockup-light"], `url("${base}logo_light/a.png")`);
  assert.equal(jan["--coop-lockup-dark"], `url("${base}seasonal/w.png")`);
  assert.equal(jan["--coop-lockup-ratio"], "2.9", "a variant without a light lockup keeps the co-op's shape");
  for (const day of ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01", "2026-12-15", "2027-01-06", "2027-01-07"]) {
    assert.deepEqual(runScript(theme, { now: `${day}T12:00:00Z` }), coop.themeVars(theme, day), day);
  }
});
