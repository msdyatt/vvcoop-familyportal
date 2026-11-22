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
  let css = "";
  for (const f of ["globals.css", "theme.css", "desktop-nav.css"]) css += await readFile(new URL(`../app/${f}`, import.meta.url), "utf8");
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

test("the manifest route's template is public/manifest.webmanifest", async () => {
  const file = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.deepEqual(manifest.MANIFEST_TEMPLATE, file);
});

test("the manifest route serves the template when the settings cannot be read, and the branded copy when they can", async () => {
  const template = manifest.MANIFEST_TEMPLATE;
  const supabase = { url: "https://abc.supabase.co", key: "pk" };

  const down = await manifest.handleManifest(supabase, async () => { throw new Error("offline"); });
  assert.deepEqual(await down.json(), template);
  assert.equal(down.headers.get("content-type"), "application/manifest+json");

  let asked = "";
  const up = await manifest.handleManifest(supabase, async (url, init) => {
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
  // The newest definition of the list: supabase/migrations/20261122090000_custom_bands.sql.
  const sql = await readFile(new URL("../supabase/migrations/20261122090000_custom_bands.sql", import.meta.url), "utf8");
  const ids = coop.PALETTES.map((p) => p.id);
  const lists = [...sql.matchAll(/array\[\s*('[a-z-]+'(?:,\s*'[a-z-]+')*)\]/g)].map((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
  const paletteLists = lists.filter((l) => l.includes("veritas"));
  assert.equal(paletteLists.length, 2, "the column check and the function's list");
  for (const l of paletteLists) assert.deepEqual(l, ids);
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

// ---- Fonts, header and sidebar, small touches ------------------------------------------------------------------------

const styleSql = await readFile(new URL("../supabase/migrations/20261120130000_coop_style.sql", import.meta.url), "utf8");
/** The ids in an SQL list like ('a', 'b', ...), wherever it is found after `marker`. */
function sqlList(marker, sql = styleSql) {
  const at = sql.indexOf(marker);
  assert.ok(at >= 0, `${marker} is in the migration`);
  const open = sql.indexOf("(", at + marker.length - 1);
  const close = sql.indexOf(")", open);
  return [...sql.slice(open + 1, close).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
}
/** The newest definitions of the band styles and of admin_save_coop_style. */
const bandsSql = await readFile(new URL("../supabase/migrations/20261122090000_custom_bands.sql", import.meta.url), "utf8");

test("the database allows exactly the fonts, styles and touches the page knows", () => {
  const heading = coop.HEADING_FONTS.map((f) => f.id);
  assert.deepEqual(sqlList("check (heading_font in ("), heading, "the table's heading font check");
  assert.deepEqual(sqlList("if coalesce(p_heading_font, '') not in ("), heading, "admin_save_coop_settings");
  const body = coop.BODY_FONTS.map((f) => f.id);
  assert.deepEqual(sqlList("check (body_font in ("), body, "the table's text font check");
  assert.deepEqual(sqlList("if coalesce(p_body_font, '') not in (", bandsSql), body, "admin_save_coop_style");
  const bands = coop.BAND_STYLES.map((b) => b.id);
  assert.deepEqual(sqlList("check (header_style in (", bandsSql), bands);
  assert.deepEqual(sqlList("check (sidebar_style in (", bandsSql), bands);
  assert.deepEqual(sqlList("if coalesce(p_header_style, '') not in (", bandsSql), bands);
  assert.deepEqual(sqlList("if coalesce(p_sidebar_style, '') not in (", bandsSql), bands);
  assert.deepEqual(sqlList("whimsy->>'season' in ("), [...coop.WHIMSY_SEASONS]);
  assert.deepEqual(sqlList("whimsy->>'marker' in ("), [...coop.WHIMSY_MARKERS]);
  // The database's default touches are the page's.
  assert.ok(styleSql.includes(`'${JSON.stringify(coop.DEFAULT_WHIMSY)}'::jsonb`), "the default whimsy");
});

test("every self-hosted font in the lists has its files, and nothing is loaded from elsewhere", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /import "\.\/fonts\.css";/, "the layout loads app/fonts.css");
  const css = await readFile(new URL("../app/fonts.css", import.meta.url), "utf8");
  const families = new Set([...css.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
  for (const f of [...coop.HEADING_FONTS, ...coop.BODY_FONTS]) {
    const first = f.stack.match(/^"([^"]+)"/)?.[1];
    if (first?.endsWith(" Variable")) assert.ok(families.has(first), `${f.label} (${first}) has an @font-face`);
  }
  for (const url of css.matchAll(/url\("([^"]+)"\)/g)) assert.match(url[1], /^\/fonts\/[a-z0-9-]+\.woff2$/, "same-origin font files only");
  const files = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]);
  for (const file of files) await readFile(new URL(`../public/fonts/${file}`, import.meta.url));
});

test("a cached theme keeps only known fonts, styles and touches; anything else falls back", () => {
  const good = coop.parseTheme({ v: 1, bodyFont: "atkinson", font: "fraunces", header: "ink", sidebar: "tint",
    whimsy: { greeting: false, village: true, season: "winter", marker: "heart", quill: false, motion: false } });
  assert.equal(good.bodyFont, "atkinson");
  assert.equal(good.font, "fraunces");
  assert.equal(good.header, "ink");
  assert.equal(good.sidebar, "tint");
  assert.deepEqual(good.whimsy, { greeting: false, village: true, season: "winter", marker: "heart", quill: false, motion: false });
  const bad = coop.parseTheme({ v: 1, bodyFont: "papyrus", header: "rainbow", sidebar: 3, whimsy: { marker: "skull", season: "monsoon", greeting: "no" } });
  assert.equal(bad.bodyFont, "inter");
  assert.equal(bad.header, "plain");
  assert.equal(bad.sidebar, "plain");
  assert.deepEqual(bad.whimsy, coop.DEFAULT_WHIMSY);
});

test("the head script puts the styles and touches on the page before it paints, as themeDataset would", () => {
  const theme = coop.parseTheme({ v: 1, accent: coop.PALETTES[0].tokens, bodyFont: "lexend", header: "accent", sidebar: "ink",
    whimsy: { greeting: false, village: false, season: "none", marker: "star", quill: false, motion: false } });
  const dataset = {};
  const set = runScript(theme, { dataset });
  assert.deepEqual(set, coop.themeVars(theme), "the fonts and colours");
  assert.equal(set["--sans"], coop.BODY_FONTS.find((f) => f.id === "lexend").stack);
  assert.deepEqual(dataset, coop.themeDataset(theme), "the attributes");
  assert.deepEqual(coop.themeDataset(theme), { coopHeader: "accent", coopSidebar: "ink", coopMarker: "star",
    coopGreeting: "off", coopVillage: "off", coopQuill: "off", coopMotion: "off" });
  // The defaults: plain bands, the diamond, and nothing turned off.
  const plain = {};
  runScript(coop.DEFAULT_THEME, { dataset: plain });
  assert.deepEqual(plain, { coopHeader: "plain", coopSidebar: "plain", coopMarker: "diamond" });
  // Junk is ignored.
  const junk = {};
  runScript({ v: 1, header: "<script>", sidebar: "x", whimsy: { marker: "skull", greeting: "no" } }, { dataset: junk });
  assert.deepEqual(junk, {});
});

test("every dataset key the theme sets is one the stylesheet reads, and every style has its rules", async () => {
  const css = await readFile(new URL("../app/desktop-nav.css", import.meta.url), "utf8");
  for (const key of coop.THEME_DATASET_KEYS) {
    const attr = "data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    assert.ok(css.includes(`[${attr}`), `${attr} is used`);
  }
  for (const b of coop.BAND_STYLES.filter((x) => x.id !== "plain")) {
    assert.ok(css.includes(`[data-coop-sidebar="${b.id}"] .side-nav`), `sidebar style ${b.id}`);
    assert.ok(css.includes(`[data-coop-header="${b.id}"] .app-header:not(.app-header-admin)`), `header style ${b.id}`);
  }
  for (const m of coop.WHIMSY_MARKERS.filter((x) => x !== "diamond")) assert.ok(css.includes(`[data-coop-marker="${m}"]`), `marker ${m}`);
});

// ---- Your own header and sidebar colours -----------------------------------------------------------------------------

test("a band of any colour, made usable, has readable text by day and by night", () => {
  let tried = 0;
  const bad = [];
  for (let hue = 0; hue < 360; hue += 20) {
    for (const [l, c] of [[0.25, 0.05], [0.4, 0.12], [0.55, 0.15], [0.7, 0.1], [0.85, 0.06], [0.95, 0.02]]) {
      const base = coop.nearestUsableBand(coop.oklchToHex(l, c, (hue * Math.PI) / 180));
      if (!base) { bad.push(`no usable shade near ${l}/${c}/${hue}`); continue; }
      tried++;
      const band = coop.bandFamily(base);
      const problems = coop.checkBand(band);
      if (problems.length) bad.push(`${base}: ${problems.join(" / ")}`);
      if (coop.contrast(band.fg, band.bg) < 4.5 || coop.contrast(band.fg_night, band.bg_night) < 4.5) bad.push(`${base}: contrast`);
      if (coop.contrast(band.bg_night, "#faf7f1") < 4.5) bad.push(`${base}: night band is not dark`);
    }
  }
  assert.ok(tried >= 100, `only ${tried} colours`);
  assert.deepEqual(bad, []);
});

test("the text on a band is the better of cream and navy; a band the text cannot be read on is refused", () => {
  assert.equal(coop.bandFamily("#2e6b4f").fg, "#faf7f1");
  assert.equal(coop.bandFamily("#f2d6a0").fg, "#0b2a3d");
  assert.equal(coop.bandFamily("#2e6b4f").bg_night, "#2e6b4f", "a dark band keeps its colour at night");
  assert.notEqual(coop.bandFamily("#f2d6a0").bg_night, "#f2d6a0", "a light one gets a deep version");
  assert.deepEqual(coop.checkBand(coop.bandFamily("#7a7a7a")), ["Text would be hard to read on this colour (4.01:1, needs 4.5:1). Choose a lighter or darker shade."]);
  assert.deepEqual(coop.checkBand({ bg: "#2e6b4f", fg: "#ffff00", bg_night: "#2e6b4f", fg_night: "#faf7f1" }), ["The text on it has to be cream or navy."]);
  assert.deepEqual(coop.checkBand(null), ["Choose a colour."]);
});

test("a cached theme with your own colour: wrong or missing colours fall back to Plain", () => {
  const band = coop.bandFamily("#2e6b4f");
  const ok = coop.parseTheme({ v: 1, header: "custom", headerBand: band, sidebar: "custom", sidebarBand: coop.bandFamily("#7a7a7a") });
  assert.equal(ok.header, "custom");
  assert.deepEqual(ok.headerBand, band);
  assert.equal(ok.sidebar, "plain", "a failing band is not worn");
  assert.equal(coop.parseTheme({ v: 1, header: "custom" }).header, "plain", "nor a missing one");
});

test("the head script dresses your own bands exactly as the page does", () => {
  const theme = coop.parseTheme({ v: 1, header: "custom", headerBand: coop.bandFamily("#2e6b4f"), sidebar: "custom", sidebarBand: coop.bandFamily("#f2d6a0") });
  const dataset = {};
  assert.deepEqual(runScript(theme, { dataset }), coop.themeVars(theme));
  const expected = coop.themeDataset(theme);
  for (const key of ["coopHeader", "coopSidebar", "coopHeaderTone", "coopSidebarTone"]) assert.equal(dataset[key], expected[key], key);
  assert.equal(dataset.coopHeaderTone, "dark");
  assert.equal(dataset.coopSidebarTone, "light");
  const plain = coop.parseTheme({ v: 1, header: "ink", headerBand: coop.bandFamily("#2e6b4f") });
  assert.equal(coop.themeVars(plain)["--coop-header-bg"], undefined, "a saved colour is not worn while another style is chosen");
  assert.equal(coop.themeDataset(plain).coopHeaderTone, undefined);
});

test("the database checks a band with the same rules", () => {
  assert.match(bandsSql, /p_band ->> 'fg' not in \('#faf7f1', '#0b2a3d'\)/);
  assert.deepEqual(Object.values(coop.BAND_INKS), ["#faf7f1", "#0b2a3d"]);
  assert.match(bandsSql, /v_day \+ 1e-9 < 4\.5/);
  assert.match(bandsSql, /v_night \+ 1e-9 < 4\.5/);
});

// ---- The page's colours --------------------------------------------------------------------------------------------

test("the head script puts the ink, page and dark theme on the page exactly as the page does", () => {
  const theme = coop.parseTheme({ v: 1, inkId: "burgundy", ink: "#3d1220", groundId: "sage", ground: coop.GROUNDS.find((g) => g.id === "sage").value,
    nightId: "from-ink", night: coop.nightFamily("#3d1220") });
  assert.equal(theme.ink, "#3d1220");
  const vars = runScript(theme);
  assert.deepEqual(vars, coop.themeVars(theme));
  assert.equal(vars["--navy"], "#3d1220");
  assert.equal(vars["--navy-rgb"], "61,18,32");
  assert.equal(vars["--ground"], theme.ground.ground);
  assert.equal(vars["--night-band"], theme.night.band);
});

test("an ink, page or dark theme outside the rule is not worn from a cache: the Veritas one is", () => {
  const t = coop.parseTheme({ v: 1, ink: "#2f6b8a", ground: { ...coop.VERITAS_GROUND, panel: "#cfd4cc" }, night: { ...coop.VERITAS_NIGHT, band: "#2b6a8f" } });
  assert.equal(t.ink, null);
  assert.equal(t.ground, null);
  assert.equal(t.night, null);
  assert.equal(t.inkId, "navy");
  assert.equal(coop.themeVars(t)["--navy"], undefined, "the stylesheet's navy stays");
});

test("the database holds the page's colours to the same rule", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261122100000_page_colours.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(`private.hex_luminance('${coop.VERITAS_INK}')`), "the ink limit is navy");
  for (const k of coop.GROUND_KEYS) assert.ok(sql.includes(`('${k}', '${coop.VERITAS_GROUND[k]}'`), `ground ${k}`);
  for (const k of coop.NIGHT_KEYS) assert.ok(sql.includes(`('${k}', '${coop.VERITAS_NIGHT[k]}'`), `night ${k}`);
});

test("the settings fetch asks for every column the theme is built from", async () => {
  const lib = await readFile(new URL("../lib/coop-theme.ts", import.meta.url), "utf8");
  const body = lib.slice(lib.indexOf("export function themeFromRow"), lib.indexOf("\n}\n", lib.indexOf("export function themeFromRow")));
  const used = new Set([...body.matchAll(/\brow\.([a-z_]+)/g)].map((m) => m[1]));
  for (const slot of coop.LOGO_SLOTS) used.add(`${slot}_path`);
  const settings = await readFile(new URL("../lib/coop-settings.ts", import.meta.url), "utf8");
  const columns = new Set(settings.match(/COOP_SETTINGS_COLUMNS =\s*"([^"]+)"/)[1].split(","));
  for (const column of used) assert.ok(columns.has(column), `${column} is fetched`);
});
