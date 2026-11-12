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
const darkAttr = blockBody(themeCss, 'html[data-theme="dark"]');
const mediaAt = themeCss.indexOf("@media (prefers-color-scheme: dark)");
const darkMedia = mediaAt >= 0 ? blockBody(themeCss, "html:not([data-theme])", mediaAt) : null;
const PAPER = [".pdf-page", ".email-paper", ".report-sheet", ".printable-report", ".roster-print-sheet", ".sign-pad", ".sign-preview"];
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
  ["fg-rgb@.66", "canvas", 4.5, "inactive tab label (iOS style)"],
  ["fg-rgb@.72", "canvas", 4.5, "inactive tab label (Android style)"],
  ["line-strong", "canvas", 3, "strong outline on the page"],
  ["line-strong", "surface", 3, "strong outline on a card"],
  ["gold", "canvas", 3, "focus ring"],
  ["gold", "surface", 3, "focus ring on a card"],
  ["terracotta", "canvas", 3, "terracotta rule or border"],
  ["sage", "canvas", 3, "sage rule or border"],
];

const themes = [["light", light]];
if (darkAttr) themes.push(["dark", { ...light, ...props(darkAttr) }]);

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
  // Roles that only matter on bands, glass bars, the calendar or the Android bar never appear inside a document.
  const notInDocuments = /^--(glass-|m3-|cal-|ink-surface|canvas-rgb|panel-rgb|accent-on-action|wash-on-action|chip-on-action)/;
  for (const name of Object.keys(props(darkAttr))) {
    if (name === "--cal-coop" || notInDocuments.test(name)) continue;
    const lightValue = resolve(name, light), darkValue = resolve(name, dark);
    if (lightValue === darkValue) continue;
    assert.ok(name in paper, `${name} changes in the dark theme but paper does not put it back`);
    assert.equal(resolve(name, { ...light, ...paper }), lightValue, `paper's ${name} is not the light value`);
  }
});
