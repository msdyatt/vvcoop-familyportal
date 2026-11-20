// Larger text (issue #140, part 2): every font size and line height in the built stylesheet follows --text-scale
// (scripts/postcss-text-scale.mjs), and the Larger setting turns it up.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { scaleValue } from "../scripts/postcss-text-scale.mjs";

test("pixel sizes in font, font-size and line-height become scaled, and nothing else changes", () => {
  assert.equal(scaleValue("14px"), "calc(14px * var(--text-scale, 1))");
  assert.equal(scaleValue("600 14px var(--sans)"), "600 calc(14px * var(--text-scale, 1)) var(--sans)");
  assert.equal(scaleValue("700 32px/36px Georgia"), "700 calc(32px * var(--text-scale, 1))/calc(36px * var(--text-scale, 1)) Georgia");
  assert.equal(scaleValue("700 clamp(42px,5vw,68px)/1.04 var(--serif)"), "700 clamp(calc(42px * var(--text-scale, 1)),5vw,calc(68px * var(--text-scale, 1)))/1.04 var(--serif)");
  for (const same of ["1.4", "inherit", "400 1rem/1.5 var(--sans)", "calc(14px * var(--text-scale, 1))"]) assert.equal(scaleValue(same), same);
});

test("the built stylesheet has no fixed pixel font size left", async () => {
  const dir = new URL("../dist/client/_next/static/css/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".css"));
  assert.ok(files.length > 0, "build first (npm test does)");
  let scaled = 0;
  for (const file of files) {
    const css = await readFile(new URL(file, dir), "utf8");
    const fixed = [...css.matchAll(/(?:font-size|line-height)\s*:\s*[\d.]+px|[{;]font\s*:[^;{}]*?[\s/][\d.]+px/g)].map((m) => m[0]);
    assert.deepEqual(fixed, [], `${file} still has fixed sizes`);
    scaled += (css.match(/--text-scale/g) ?? []).length;
  }
  assert.ok(scaled > 500, `only ${scaled} scaled sizes`);
});

test("Larger turns the scale up, and nothing else sets it", async () => {
  const css = await readFile(new URL("../app/appearance.css", import.meta.url), "utf8");
  assert.match(css, /:root \{ --text-scale:1; \}/);
  assert.match(css, /html\[data-text-size="large"\] \{ --text-scale:1\.15; \}/);
  const lib = await readFile(new URL("../lib/coop-theme.ts", import.meta.url), "utf8");
  assert.match(lib, /LARGE_TEXT_SCALE = 1\.15;/);
});
