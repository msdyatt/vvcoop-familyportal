/**
 * "Larger text" (issue #140, part 2; app/appearance.css). The stylesheets give font sizes and line heights in
 * pixels, so a person's text size cannot come from a root font size. At build time this rewrites every pixel value
 * in `font-size`, `line-height` and the `font` shorthand to `calc(<px> * var(--text-scale, 1))`; --text-scale is 1
 * normally and larger when the person chooses Larger text. Nothing else (spacing, borders, icons) changes.
 * Tested in tests/text-scale.test.mjs.
 */
const PROPS = new Set(["font-size", "line-height", "font"]);
const PX = /(^|[\s(,/])(\d*\.?\d+)px\b/g;

export function scaleValue(value) {
  if (value.includes("--text-scale")) return value;
  return value.replace(PX, (_, before, n) => `${before}calc(${n}px * var(--text-scale, 1))`);
}

export default function textScale() {
  return {
    postcssPlugin: "vv-text-scale",
    Declaration(decl) {
      if (!PROPS.has(decl.prop.toLowerCase()) || !decl.value.includes("px")) return;
      const next = scaleValue(decl.value);
      if (next !== decl.value) decl.value = next;
    },
  };
}
textScale.postcss = true;
