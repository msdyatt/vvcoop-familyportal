// Contrast check for the theme role tokens (docs/theming.md).
//
// Reads the real token values out of app/globals.css, so a colour change that
// breaks readability fails here rather than in someone's evening. Every pair is
// a text/background (or boundary/background) combination the CSS actually
// produces. 4.5:1 for text, 3:1 for large text and for UI boundaries.
//
// If you add a role or a new pairing, add it to PAIRS.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// The co-op palettes (lib/coop-theme.ts), transpiled so the generator the admin screen uses is the one tested here.
const coopDir = await mkdtemp(path.join(tmpdir(), "coop-theme-"));
{
  const source = readFileSync(new URL("../lib/coop-theme.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(coopDir, "coop-theme.mjs"), outputText);
}
const coop = await import(pathToFileURL(path.join(coopDir, "coop-theme.mjs")).href);

const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"));   // the roles, for the light theme
const themeCss = strip(readFileSync(new URL("../app/theme.css", import.meta.url), "utf8")); // dark, and paper

/** Body of the first top-level-or-nested block whose selector text is exactly `selector`. */
function blockBody(source, selector, from = 0) {
  const at = source.indexOf(selector + " {", from) >= 0 ? source.indexOf(selector + " {", from) : source.indexOf(selector + "{", from);
  if (at < 0) return null;
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

function props(body) {
  const out = {};
  if (!body) return out;
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = props(blockBody(css, ":root"));
const darkAttr = blockBody(themeCss, 'html[data-theme="dark"],\n.theme-preview-dark');
const mediaAt = themeCss.indexOf("@media (prefers-color-scheme: dark)");
const darkMedia = mediaAt >= 0 ? blockBody(themeCss, "html:not([data-theme])", mediaAt) : null;
const PAPER = [".pdf-page", ".email-paper", ".report-sheet", ".printable-report", ".roster-print-sheet", ".sign-pad", ".sign-preview", ".theme-preview-light"];
const paperBody = blockBody(themeCss, PAPER.join(",\n"));

function resolve(name, vars, depth = 0) {
  let v = vars[name];
  if (v === undefined || depth > 12) return undefined;
  const m = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return m ? resolve(m[1], vars, depth + 1) : v;
}

function rgbOf(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "white") return [255, 255, 255];
  let m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = v.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));

/** A colour reference in PAIRS: a role/brand token name, "white", or "fg-rgb@.66" (a tint at that alpha, composited over the background). */
function colour(ref, vars, bg) {
  const [name, alpha] = ref.split("@");
  const raw = name === "white" ? "white" : resolve("--" + name, vars);
  const c = rgbOf(raw);
  assert.ok(c, `could not resolve --${name} to a colour (got ${raw})`);
  return alpha ? over(c, bg, Number(alpha)) : c;
}

// [foreground, background, minimum ratio, what it is, optional per-theme minimum {light: n} or {dark: n}]
const PAIRS = [
  ["text", "canvas", 4.5, "body text on the page"],
  ["text", "surface", 4.5, "text on a raised card"],
  ["text", "surface-sunken", 4.5, "text in an input"],
  ["text", "panel", 4.5, "text on a sage panel"],
  ["text", "warm-tint", 4.5, "text on a warm callout"],
  ["text", "field-bg", 4.5, "text on a sign-in field"],
  ["text-muted", "canvas", 4.5, "secondary text on the page"],
  ["text-muted", "surface", 4.5, "secondary text on a card"],
  ["text-muted", "surface-sunken", 4.5, "secondary text in an input"],
  ["text-muted", "panel", 4.5, "secondary text on a sage panel"],
  ["text-accent", "canvas", 4.5, "small accent text on the page"],
  ["text-accent", "surface", 4.5, "small accent text on a card"],
  ["danger-text", "warm-tint", 4.5, "alert text on a warm tint"],
  ["danger-text", "canvas", 4.5, "alert text on the page"],
  ["danger-text", "surface", 4.5, "alert text on a card"],
  ["accent-ink", "canvas", 3, "terracotta emphasis in large headings"],
  ["text-soft", "canvas", 3, "decorative large de-emphasised text"],
  ["cream", "ink-surface", 4.5, "text on a navy band"],
  ["white", "ink-surface", 4.5, "bright text on a navy band"],
  ["sage-on-navy", "ink-surface", 4.5, "muted text on a navy band"],
  ["terracotta-on-navy", "ink-surface", 4.5, "accent text on a navy band"],
  ["cream", "action", 4.5, "button label"],
  ["accent-on-action", "action", 4.5, "mention and label text inside a bubble"],
  ["white", "action", 4.5, "button label (white)"],
  ["cream", "danger-fill", 4.5, "urgent banner text"],
  ["white", "danger-fill", 4.5, "error toast text"],
  ["cream", "accent-fill", 4.5, "today's date marker"],
  ["white", "terracotta-text", 4.5, "white on a status chip (needs-attention)"],
  ["white", "sage-text", 4.5, "white on a status chip (complete)"],
  ["cream", "cal-coop", 4.5, "co-op event pill"],
  ["cream", "cal-class", 4.5, "class event pill"],
  ["cream", "cal-admin", 4.5, "admin-only event pill"],
  ["fg-rgb@.66", "canvas", 4.5, "inactive tab label (iOS style)"],
  ["fg-rgb@.72", "canvas", 4.5, "inactive tab label (Android style)"],
  ["m3-on-secondary-container", "m3-secondary-container", 4.5, "selected tab label (Android style)"],
  ["accent-ink", "surface", 3, "accent emphasis on a card"],
  ["status-new", "surface", 3, "office inbox: New status mark"],
  ["status-open", "surface", 3, "office inbox: Open status mark"],
  ["status-waiting", "surface", 3, "office inbox: Waiting on family status mark"],
  ["status-done", "surface", 3, "office inbox: Done status mark"],
  ["line-strong", "canvas", 3, "strong outline on the page"],
  ["line-strong", "surface", 3, "strong outline on a card"],
  ["gold", "canvas", 3, "focus ring"],
  ["gold", "surface", 3, "focus ring on a card"],
  ["terracotta", "canvas", 3, "terracotta rule or border"],
  ["sage", "canvas", 3, "sage rule or border"],
];

const themes = [["light", light]];
if (darkAttr) themes.push(["dark", { ...light, ...props(darkAttr) }]);

/** The pairs that fail for one set of token values: [{fg, bg, got, min}]. */
function failures(theme, vars) {
  const out = [];
  for (const [fg, bg, wanted, what, override] of PAIRS) {
    const min = override?.[theme] ?? wanted;
    const back = colour(bg, vars, [0, 0, 0]);
    const got = ratio(colour(fg, vars, back), back);
    if (got < min) out.push(`${what} (${fg} on ${bg}) ${got.toFixed(2)}:1 < ${min}:1`);
  }
  return out;
}

/** The stylesheet's tokens with a co-op palette in place: the ten brand-level properties it sets (ACCENT_VARS). */
function withAccent(vars, tokens) {
  const next = { ...vars };
  for (const key of coop.ACCENT_KEYS) next[coop.ACCENT_VARS[key]] = tokens[key];
  return next;
}

for (const [theme, vars] of themes) {
  for (const [fg, bg, wanted, what, override] of PAIRS) {
    const min = override?.[theme] ?? wanted;
    test(`${theme}: ${what} (${fg} on ${bg}) is at least ${min}:1`, () => {
      const back = colour(bg, vars, [0, 0, 0]);
      const front = colour(fg, vars, back);
      const got = ratio(front, back);
      assert.ok(got >= min, `${fg} on ${bg} is ${got.toFixed(2)}:1, needs ${min}:1`);
    });
  }
}

if (darkAttr) {
  test("the two dark blocks (explicit choice and System) are identical", () => {
    assert.ok(darkMedia, 'missing @media (prefers-color-scheme: dark) { html:not([data-theme]) { … } }');
    const norm = (p) => JSON.stringify(Object.entries(p).sort());
    assert.equal(norm(props(darkMedia)), norm(props(darkAttr)));
  });
}

test("paper keeps the light roles: every role the dark theme changes is put back, to the light value", () => {
  assert.ok(paperBody, "missing the Paper block in app/theme.css");
  const paper = props(paperBody);
  const dark = { ...light, ...props(darkAttr) };
  // Roles that only matter on bands, glass bars, the calendar, the Android bar or the office inbox never appear inside a document.
  const notInDocuments = /^--(glass-|m3-|cal-|status-|ink-surface|canvas-rgb|panel-rgb|accent-on-action|wash-on-action|chip-on-action)/;
  for (const name of Object.keys(props(darkAttr))) {
    if (name === "--cal-coop" || notInDocuments.test(name)) continue;
    const lightValue = resolve(name, light), darkValue = resolve(name, dark);
    if (lightValue === darkValue) continue;
    assert.ok(name in paper, `${name} changes in the dark theme but paper does not put it back`);
    assert.equal(resolve(name, { ...light, ...paper }), lightValue, `paper's ${name} is not the light value`);
  }
});

// ---- Co-op palettes (lib/coop-theme.ts) ---------------------------------------------------------------------------

test("the Veritas palette in lib/coop-theme.ts is exactly the stylesheet's accent colours", () => {
  for (const key of coop.ACCENT_KEYS) assert.equal(coop.VERITAS_ACCENT[key], light[coop.ACCENT_VARS[key]], `${key} (${coop.ACCENT_VARS[key]})`);
});

test("the database's default palette is the Veritas palette too", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261120090000_coop_settings.sql", import.meta.url), "utf8");
  const literal = sql.match(/function private\.default_coop_accent\(\)[\s\S]*?select '(\{[\s\S]*?\})'::jsonb/)[1];
  assert.deepEqual(JSON.parse(literal), coop.VERITAS_ACCENT);
});

test("the backgrounds the palette checks use are the stylesheet's own", () => {
  const dark = themes.find(([t]) => t === "dark")[1];
  const B = coop.ROLE_BACKGROUNDS;
  const hex = (v) => "#" + rgbOf(v).map((c) => c.toString(16).padStart(2, "0")).join("");
  assert.equal(B.canvas, hex(resolve("--canvas", light)));
  assert.equal(B.surface, hex(resolve("--surface", light)));
  assert.equal(B.cream, hex(resolve("--cream", light)));
  assert.equal(B.navy, hex(resolve("--ink-surface", light)));
  assert.equal(B.navy, hex(resolve("--action", light)));
  assert.equal(B["night canvas"], hex(resolve("--canvas", dark)));
  assert.equal(B["night surface"], hex(resolve("--surface", dark)));
  assert.equal(B["night band"], hex(resolve("--ink-surface", dark)));
});

test("a palette sets only the accent family: no alert, error, ink or background token reads an accent property", () => {
  const accentVars = new Set(coop.ACCENT_KEYS.map((k) => coop.ACCENT_VARS[k]));
  const readsAccent = (name, vars, seen = new Set()) => {
    if (accentVars.has(name)) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const m = String(vars[name] ?? "").match(/^var\((--[a-z0-9-]+)\)$/);
    return m ? readsAccent(m[1], vars, seen) : false;
  };
  for (const [theme, vars] of themes) {
    for (const name of ["--danger-text", "--danger-fill", "--danger-line", "--terracotta-deep", "--warm-tint", "--text", "--canvas", "--surface", "--ink-surface", "--gold", "--line-strong"]) {
      assert.ok(name in vars, `${name} is defined`);
      assert.ok(!readsAccent(name, vars), `${theme}: ${name} must not follow the co-op's palette`);
    }
  }
});

for (const palette of coop.PALETTES) {
  test(`palette "${palette.label}" passes its own checks and every token pair in both themes`, () => {
    assert.deepEqual(coop.checkAccent(palette.tokens).map((p) => p.message), []);
    for (const [theme, vars] of themes) assert.deepEqual(failures(theme, withAccent(vars, palette.tokens)), [], theme);
  });
}

test("a custom colour of any hue, made usable, generates a palette that passes every token pair in both themes", () => {
  const bad = [];
  let tried = 0;
  for (let hue = 0; hue < 360; hue += 15) {
    for (const [l, c] of [[0.45, 0.05], [0.55, 0.12], [0.62, 0.18], [0.7, 0.1], [0.35, 0.15]]) {
      const base = coop.nearestUsableAccent(coop.oklchToHex(l, c, (hue * Math.PI) / 180));
      if (!base) continue;
      tried++;
      const tokens = coop.generateAccent(base);
      const own = coop.checkAccent(tokens).map((p) => p.message);
      if (own.length) bad.push(`${base}: ${own.join(" / ")}`);
      for (const [theme, vars] of themes) for (const f of failures(theme, withAccent(vars, tokens))) bad.push(`${base} ${theme}: ${f}`);
    }
  }
  assert.ok(tried >= 100, `only ${tried} colours were tried`);
  assert.deepEqual(bad, []);
});

test("the palette check refuses what the token pairs would fail, and says why in plain words", () => {
  const pale = coop.checkAccent(coop.generateAccent("#f5d76e"));
  assert.ok(pale.length > 0, "a pale yellow accent is refused");
  assert.match(pale[0].message, /^Too close to its background for lines and large headings on the page \(1\.\d\d:1, needs 3:1\)\. Choose a darker shade\.$/);
  const navyish = coop.checkAccent(coop.generateAccent("#1a3a6a"));
  assert.ok(navyish.some((p) => /dark theme.*Choose a lighter shade/.test(p.message)), "a navy-like accent is refused for the dark theme");
  // Whatever checkAccent lets through, the full pair list agrees with (the other direction is the loop above).
  for (const base of ["#f5d76e", "#1a3a6a", "#000000", "#ffffff", "#00ff00", "#0000ff"]) {
    const tokens = coop.generateAccent(base);
    const pairsFail = themes.some(([theme, vars]) => failures(theme, withAccent(vars, tokens)).length > 0);
    if (pairsFail) assert.ok(coop.checkAccent(tokens).length > 0, `${base} fails a token pair but passed checkAccent`);
  }
  assert.ok(coop.checkAccent({ ...coop.VERITAS_ACCENT, accent_text: "red" }).length > 0, "a colour that is not #rrggbb is refused");
});

test("a cached theme is taken whole or not at all", () => {
  const good = { v: 1, name: "Riverbend", accent: coop.PALETTES[1].tokens, font: "georgia", logos: { logo_light: "https://x.supabase.co/storage/v1/object/public/coop-brand/logo_light/a.png" }, ratio: 3 };
  const parsed = coop.parseTheme(good);
  assert.equal(parsed.name, "Riverbend");
  assert.deepEqual(parsed.accent, coop.PALETTES[1].tokens);
  assert.equal(parsed.logos.logo_light, good.logos.logo_light);
  assert.deepEqual(coop.parseTheme({ ...good, accent: { ...good.accent, accent: "#f5d76e" } }).accent, coop.VERITAS_ACCENT, "a failing accent falls back");
  assert.equal(coop.parseTheme({ ...good, logos: { logo_light: "https://evil.example/x.png" } }).logos.logo_light, undefined, "a logo from elsewhere is ignored");
  assert.equal(coop.parseTheme({ ...good, logos: { logo_light: 'https://x.supabase.co/storage/v1/object/public/coop-brand/a.png");background:url("x' } }).logos.logo_light, undefined, "and cannot break out of url()");
  assert.equal(coop.parseTheme({ ...good, font: "comic" }).font, "playfair");
  assert.deepEqual(coop.parseTheme("junk"), coop.DEFAULT_THEME);
});
