/**
 * The co-op's own look (docs/theming.md, "Co-op theme"): its name, logos, accent palette and heading font.
 *
 * Pure functions only, so the Node tests, the admin screen and the pre-paint script all share one definition.
 * The settings themselves live in public.coop_settings (one row) and reach the page through lib/coop-settings.ts.
 *
 * What a co-op can change, and what it cannot:
 * - The accent: the brand's terracotta family. Ten colours (light and dark variants) that feed the role tokens
 *   through a handful of brand-level custom properties (ACCENT_VARS). Ink (navy), the canvas, the surfaces, the
 *   focus gold and every alert or error colour stay as they are, so urgent and error styles cannot be themed away.
 * - The heading and body fonts, from lists of self-hosted faces (HEADING_FONTS, BODY_FONTS; app/fonts.css).
 * - How the header and the sidebar are drawn (BAND_STYLES), from colours that are already checked: the page, the
 *   accent's own tint, the navy band or the accent's deep fill. Admin keeps its navy band whatever is chosen.
 * - The small touches (WHIMSY): greeting, village, season, the marker's shape, the quill underline, motion.
 * - The logos (lockup and compact mark, each for light and dark grounds), uploaded to the coop-brand bucket.
 *
 * Every accent is checked against the role backgrounds it is drawn on (ACCENT_CHECKS): 4.5:1 for text, 3:1 for
 * lines, marks and large text. The same checks run in the database before a palette is saved
 * (private.coop_accent_problems), and tests/theme-contrast.test.mjs runs the full token pair list over every
 * ready-made palette and a spread of generated ones.
 */

export type Rgb = [number, number, number];

// ---- Colour arithmetic ------------------------------------------------------------------------------------

export const HEX_RE = /^#[0-9a-f]{6}$/;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/** "#AbC" or "abcdef" or " #ABCDEF " to "#abcdef"; null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  return HEX_RE.test(v) ? v : null;
}

export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

export function rgbToHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("");
}

const toLinear = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// OKLab / OKLCH, for making lighter and darker versions of a colour that keep its hue.
const srgbToLin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const linToSrgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const [r, g, b] = hexToRgb(hex).map(srgbToLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) };
}

function oklchToLinear(L: number, C: number, h: number): Rgb {
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** An OKLCH colour as hex, with the chroma reduced as far as needed to fit in sRGB. */
export function oklchToHex(L: number, C: number, h: number): string {
  L = Math.max(0, Math.min(1, L));
  let lo = 0, hi = C;
  if (!inGamut(oklchToLinear(L, C, h))) {
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid; }
    C = lo;
  }
  return rgbToHex(oklchToLinear(L, C, h).map((v) => linToSrgb(Math.max(0, Math.min(1, v)))) as Rgb);
}

/** The colour of this hue and chroma whose lightness is closest to `target` and that passes `ok`; null if none does. */
function nearestLightness(h: number, c: number, target: number, ok: (hex: string) => boolean): string | null {
  let best: string | null = null, bestDistance = Infinity;
  for (let i = 0; i <= 400; i++) {
    const L = i / 400;
    const distance = Math.abs(L - target);
    if (distance >= bestDistance) continue;
    const hex = oklchToHex(L, c, h);
    if (ok(hex)) { best = hex; bestDistance = distance; }
  }
  return best;
}

// ---- The accent ---------------------------------------------------------------------------------------------

export const ACCENT_KEYS = [
  "accent", "accent_text", "accent_on_ink", "accent_deep", "accent_tint", "accent_tint_ink",
  "night_ink", "night_fill", "night_tint", "night_tint_ink",
] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];
export type AccentTokens = Record<AccentKey, string>;

/**
 * The brand-level custom properties each accent colour sets (app/globals.css). The role tokens read them, in
 * both themes, so the co-op's palette only ever has to set these ten; the dark blocks never redefine them.
 */
export const ACCENT_VARS: Record<AccentKey, string> = {
  accent: "--terracotta",                    // rules, borders, large headings, status marks (light)
  accent_text: "--terracotta-text",          // small accent text on light grounds; class pills; chips with white text
  accent_on_ink: "--terracotta-on-navy",     // accent text on navy bands and buttons; small accent text at night
  accent_deep: "--accent-deep",              // a deep accent fill with cream text (today's date)
  accent_tint: "--accent-tint",              // a light wash (Android's selected tab)
  accent_tint_ink: "--accent-tint-ink",      // text on that wash
  night_ink: "--accent-night",               // dark theme: large emphasis, status marks
  night_fill: "--accent-night-fill",         // dark theme: primary buttons, selected tabs, class pills (cream text)
  night_tint: "--accent-night-tint",         // dark theme: Android's selected tab
  night_tint_ink: "--accent-night-tint-ink", // dark theme: text on that
};

/** The Veritas Village palette: exactly the colours the portal has always had. */
export const VERITAS_ACCENT: AccentTokens = {
  accent: "#bb6141",
  accent_text: "#a85539",
  accent_on_ink: "#d7a590",
  accent_deep: "#6b3826",
  accent_tint: "#efd9cd",
  accent_tint_ink: "#4a2417",
  night_ink: "#e8a98d",
  night_fill: "#a85539",
  night_tint: "#5b3324",
  night_tint_ink: "#f6d9cb",
};

/**
 * The role backgrounds the accent is drawn on, as the light and dark themes define them (app/globals.css,
 * app/theme.css). These are not themeable. tests/theme-contrast.test.mjs checks they match the stylesheets.
 */
export const ROLE_BACKGROUNDS = {
  "canvas": "#faf7f1",
  "surface": "#fffdf9",
  "cream": "#faf7f1",
  "white": "#ffffff",
  "navy": "#0b2a3d",
  "night canvas": "#08202f",
  "night surface": "#0e3045",
  "night band": "#0d3a57",
} as const;
type Ground = keyof typeof ROLE_BACKGROUNDS;

/**
 * [accent colour, what it is drawn with, minimum ratio, where people see it]. "with" is the background or, for a
 * fill, the text colour on it. Mirrored in the database by private.coop_accent_problems.
 */
export const ACCENT_CHECKS: [AccentKey, Ground, number, string][] = [
  ["accent", "canvas", 3, "lines and large headings on the page"],
  ["accent", "surface", 3, "lines and marks on cards"],
  ["accent", "night canvas", 3, "lines and borders on the page in the dark theme"],
  ["accent", "night surface", 3, "lines and borders on cards in the dark theme"],
  ["accent_text", "canvas", 4.5, "small accent text on the page"],
  ["accent_text", "surface", 4.5, "small accent text on cards"],
  ["accent_text", "white", 4.5, "white labels on accent chips"],
  ["accent_text", "cream", 4.5, "labels on class events in the calendar"],
  ["accent_on_ink", "navy", 4.5, "accent text on navy bands and buttons"],
  ["accent_on_ink", "night band", 4.5, "accent text on bands in the dark theme"],
  ["accent_on_ink", "night canvas", 4.5, "small accent text in the dark theme"],
  ["accent_on_ink", "night surface", 4.5, "small accent text on cards in the dark theme"],
  ["accent_deep", "cream", 4.5, "the label on today's date"],
  ["night_ink", "night canvas", 3, "headings and marks in the dark theme"],
  ["night_ink", "night surface", 3, "marks on cards in the dark theme"],
  ["night_fill", "cream", 4.5, "button labels in the dark theme"],
  ["night_fill", "white", 4.5, "white button labels in the dark theme"],
];
/** Text on a tint: [text, tint, minimum, where]. */
export const TINT_CHECKS: [AccentKey, AccentKey, number, string][] = [
  ["accent_tint_ink", "accent_tint", 4.5, "the selected tab on Android"],
  ["night_tint_ink", "night_tint", 4.5, "the selected tab on Android in the dark theme"],
];

export type AccentProblem = { key: AccentKey; ratio: number; need: number; where: string; message: string };

const fmt = (n: number) => (Math.floor(n * 100) / 100).toFixed(2);

/** Every check the palette fails, each with a plain explanation. An empty list means it can be saved. */
export function checkAccent(tokens: Partial<Record<AccentKey, unknown>>): AccentProblem[] {
  const problems: AccentProblem[] = [];
  for (const key of ACCENT_KEYS) {
    if (!isHex(tokens[key])) problems.push({ key, ratio: 0, need: 0, where: key, message: `The palette is missing its ${key.replaceAll("_", " ")} colour.` });
  }
  if (problems.length) return problems;
  const t = tokens as AccentTokens;
  for (const [key, ground, need, where] of ACCENT_CHECKS) {
    const ratio = contrast(t[key], ROLE_BACKGROUNDS[ground]);
    if (ratio + 1e-9 < need) {
      // Which way to move: darker against a light ground (or under cream or white text), lighter against a dark one.
      const fix = luminance(ROLE_BACKGROUNDS[ground]) > 0.5 ? "a darker shade" : "a lighter shade";
      problems.push({ key, ratio, need, where, message: `Too close to its background for ${where} (${fmt(ratio)}:1, needs ${need}:1). Choose ${fix}.` });
    }
  }
  for (const [text, tint, need, where] of TINT_CHECKS) {
    const ratio = contrast(t[text], t[tint]);
    if (ratio + 1e-9 < need) problems.push({ key: text, ratio, need, where, message: `Text is too faint on ${where} (${fmt(ratio)}:1, needs ${need}:1).` });
  }
  return problems;
}

/**
 * The full palette for one chosen accent colour. The colour itself is used as is for rules, borders and large
 * headings; the others are generated from its hue, each the nearest in lightness to what looks right that clears
 * its contrast checks with a small margin. Only the chosen colour can fail (too pale for the light page or too
 * dark for the dark one): checkAccent says so, and nearestUsableAccent offers the closest shade that works.
 */
export function generateAccent(base: string): AccentTokens {
  const { l, c, h } = hexToOklch(base);
  const margin = 0.1;
  const atLeast = (hex: string, grounds: string[], need: number) => grounds.every((g) => contrast(hex, g) >= need + margin);
  const B = ROLE_BACKGROUNDS;
  const pick = (target: number, chroma: number, ok: (hex: string) => boolean, fallback: string) =>
    nearestLightness(h, chroma, target, ok) ?? fallback;

  const accent_text = pick(l, c, (x) => atLeast(x, [B.canvas, B.surface, B.white], 4.5), "#5b2e1f");
  const accent_on_ink = pick(Math.max(l, 0.78), c, (x) => atLeast(x, [B.navy, B["night band"], B["night canvas"], B["night surface"]], 4.5), "#f3dccf");
  const accent_deep = pick(0.36, c, (x) => atLeast(x, [B.cream], 7), "#3d2015");
  const accent_tint = oklchToHex(0.92, Math.min(c, 0.04), h);
  const accent_tint_ink = pick(0.32, Math.min(c, 0.09), (x) => contrast(x, accent_tint) >= 7, "#2a160e");
  const night_ink = pick(Math.max(l, 0.78), Math.min(c, 0.12), (x) => atLeast(x, [B["night canvas"], B["night surface"]], 4.5), "#f0c8b6");
  const night_fill = pick(l, c, (x) => atLeast(x, [B.cream, B.white], 4.5), "#7a3d28");
  const night_tint = oklchToHex(0.35, Math.min(c, 0.07), h);
  const night_tint_ink = pick(0.9, Math.min(c, 0.04), (x) => contrast(x, night_tint) >= 7, "#fbeee7");
  return { accent: base, accent_text, accent_on_ink, accent_deep, accent_tint, accent_tint_ink, night_ink, night_fill, night_tint, night_tint_ink };
}

/** The shade of this hue nearest in lightness to `base` that works as the main accent in both themes; null if none. */
export function nearestUsableAccent(base: string): string | null {
  const { l, c, h } = hexToOklch(base);
  const B = ROLE_BACKGROUNDS;
  return nearestLightness(h, c, l, (x) =>
    [B.canvas, B.surface].every((g) => contrast(x, g) >= 3.05) && [B["night canvas"], B["night surface"]].every((g) => contrast(x, g) >= 3.05));
}

// ---- Ready-made palettes ----------------------------------------------------------------------------------------

export type Palette = { id: string; label: string; tokens: AccentTokens };

/**
 * Hand-picked accents, the current Veritas palette first. Each has a generated family that passes every check
 * (the contrast test runs them all). "custom" is not in this list: it is any colour the admin types.
 */
export const PALETTES: Palette[] = [
  { id: "veritas", label: "Terracotta (Veritas)", tokens: VERITAS_ACCENT },
  { id: "meadow", label: "Meadow green", tokens: generateAccent("#4f8a55") },
  { id: "harbor", label: "Harbor blue", tokens: generateAccent("#4a84c0") },
  { id: "plum", label: "Plum", tokens: generateAccent("#a0629f") },
  { id: "teal", label: "Teal", tokens: generateAccent("#2f8c86") },
  { id: "ochre", label: "Ochre", tokens: generateAccent("#b07f2c") },
];

export const DEFAULT_PALETTE_ID = "veritas";
export const CUSTOM_PALETTE_ID = "custom";

export function paletteById(id: unknown): Palette | undefined {
  return PALETTES.find((p) => p.id === id);
}

// ---- Fonts -------------------------------------------------------------------------------------------------------

/**
 * Heading faces. Playfair Display and Inter are hosted with the site, Georgia and the book serif are on every device,
 * and the rest are self-hosted variable fonts (app/fonts.css, SIL Open Font License). A browser only downloads the
 * one in use, so a long list costs nothing. The ids are also checked in the database (coop_settings.heading_font);
 * tests/coop-theme.test.mjs keeps the two lists the same.
 */
export const HEADING_FONTS = [
  { id: "playfair", label: "Playfair Display", group: "Classic serif", hint: "The portal's own serif", stack: '"Playfair Display",Georgia,"Times New Roman",serif' },
  { id: "georgia", label: "Georgia", group: "Classic serif", hint: "A plain, sturdy serif", stack: 'Georgia,"Times New Roman",serif' },
  { id: "book", label: "Book serif", group: "Classic serif", hint: "Palatino or Iowan, like a printed book", stack: '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif' },
  { id: "eb-garamond", label: "EB Garamond", group: "Classic serif", hint: "Old-style and bookish", stack: '"EB Garamond Variable",Garamond,Georgia,serif' },
  { id: "cormorant", label: "Cormorant Garamond", group: "Classic serif", hint: "Tall and elegant", stack: '"Cormorant Garamond Variable",Garamond,Georgia,serif' },
  { id: "lora", label: "Lora", group: "Classic serif", hint: "Warm, with gentle curves", stack: '"Lora Variable",Georgia,serif' },
  { id: "merriweather", label: "Merriweather", group: "Classic serif", hint: "Sturdy and easy to read", stack: '"Merriweather Variable",Georgia,serif' },
  { id: "source-serif", label: "Source Serif", group: "Classic serif", hint: "Clean and modern", stack: '"Source Serif 4 Variable",Georgia,serif' },
  { id: "literata", label: "Literata", group: "Classic serif", hint: "Made for reading on screens", stack: '"Literata Variable",Georgia,serif' },
  { id: "alegreya", label: "Alegreya", group: "Classic serif", hint: "Lively, a little calligraphic", stack: '"Alegreya Variable",Georgia,serif' },
  { id: "fraunces", label: "Fraunces", group: "Storybook", hint: "Soft and a little old-fashioned", stack: '"Fraunces Variable",Georgia,serif' },
  { id: "comfortaa", label: "Comfortaa", group: "Storybook", hint: "Round and playful", stack: '"Comfortaa Variable",system-ui,sans-serif' },
  { id: "quicksand", label: "Quicksand", group: "Storybook", hint: "Light and friendly", stack: '"Quicksand Variable",system-ui,sans-serif' },
  { id: "nunito", label: "Nunito", group: "Storybook", hint: "Rounded and warm", stack: '"Nunito Variable",system-ui,sans-serif' },
  { id: "caveat", label: "Caveat", group: "Handwritten", hint: "Like a quick note", stack: '"Caveat Variable","Bradley Hand",cursive' },
  { id: "dancing", label: "Dancing Script", group: "Handwritten", hint: "Joined-up script", stack: '"Dancing Script Variable","Snell Roundhand",cursive' },
  { id: "sans", label: "Same as the text", group: "Modern sans", hint: "Headings in the body font", stack: "var(--sans)" },
  { id: "montserrat", label: "Montserrat", group: "Modern sans", hint: "Geometric and bold", stack: '"Montserrat Variable",system-ui,sans-serif' },
  { id: "raleway", label: "Raleway", group: "Modern sans", hint: "Slim and stylish", stack: '"Raleway Variable",system-ui,sans-serif' },
  { id: "josefin", label: "Josefin Sans", group: "Modern sans", hint: "Vintage and geometric", stack: '"Josefin Sans Variable",system-ui,sans-serif' },
  { id: "lexend", label: "Lexend", group: "Modern sans", hint: "Wide and very clear", stack: '"Lexend Variable",system-ui,sans-serif' },
  { id: "work-sans", label: "Work Sans", group: "Modern sans", hint: "Plain and steady", stack: '"Work Sans Variable",system-ui,sans-serif' },
] as const;
export type HeadingFontId = (typeof HEADING_FONTS)[number]["id"];
export const DEFAULT_HEADING_FONT: HeadingFontId = "playfair";

export function isHeadingFont(value: unknown): value is HeadingFontId {
  return HEADING_FONTS.some((f) => f.id === value);
}

/** Body text faces: chosen for long reading, so no display or handwritten fonts. Checked in the database too. */
export const BODY_FONTS = [
  { id: "inter", label: "Inter", group: "Sans serif", hint: "The portal's own text font", stack: 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif' },
  { id: "system", label: "The device's own", group: "Sans serif", hint: "San Francisco, Segoe or Roboto", stack: 'system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif' },
  { id: "atkinson", label: "Atkinson Hyperlegible", group: "Sans serif", hint: "Designed to be easy to tell letters apart", stack: '"Atkinson Hyperlegible Next Variable",system-ui,sans-serif' },
  { id: "lexend", label: "Lexend", group: "Sans serif", hint: "Wide spacing, easy on tired eyes", stack: '"Lexend Variable",system-ui,sans-serif' },
  { id: "source-sans", label: "Source Sans", group: "Sans serif", hint: "Neat and compact", stack: '"Source Sans 3 Variable",system-ui,sans-serif' },
  { id: "open-sans", label: "Open Sans", group: "Sans serif", hint: "Friendly and familiar", stack: '"Open Sans Variable",system-ui,sans-serif' },
  { id: "work-sans", label: "Work Sans", group: "Sans serif", hint: "Plain and steady", stack: '"Work Sans Variable",system-ui,sans-serif' },
  { id: "nunito", label: "Nunito", group: "Sans serif", hint: "Rounded and warm", stack: '"Nunito Variable",system-ui,sans-serif' },
  { id: "literata", label: "Literata", group: "Serif", hint: "Made for reading on screens", stack: '"Literata Variable",Georgia,serif' },
  { id: "source-serif", label: "Source Serif", group: "Serif", hint: "Clean and modern", stack: '"Source Serif 4 Variable",Georgia,serif' },
  { id: "lora", label: "Lora", group: "Serif", hint: "Warm, with gentle curves", stack: '"Lora Variable",Georgia,serif' },
  { id: "merriweather", label: "Merriweather", group: "Serif", hint: "Sturdy and easy to read", stack: '"Merriweather Variable",Georgia,serif' },
] as const;
export type BodyFontId = (typeof BODY_FONTS)[number]["id"];
export const DEFAULT_BODY_FONT: BodyFontId = "inter";

export function isBodyFont(value: unknown): value is BodyFontId {
  return BODY_FONTS.some((f) => f.id === value);
}

// ---- Header and sidebar -----------------------------------------------------------------------------------------

/**
 * How the header band and the sidebar are drawn. Each style only pairs colours that are already checked for
 * contrast (docs/theming.md): the page's own surfaces; the accent's tint with its ink; the navy band with cream; the
 * accent's deep fill with cream. So a band can never make its text unreadable, whatever the palette.
 */
export const BAND_STYLES = [
  { id: "plain", label: "Plain", hint: "The page colour, with an accent rule" },
  { id: "tint", label: "Tinted", hint: "A soft wash of the accent colour" },
  { id: "ink", label: "Ink", hint: "The deep navy band, like Admin" },
  { id: "accent", label: "Accent", hint: "The accent colour, deep and bold" },
] as const;
export type BandStyle = (typeof BAND_STYLES)[number]["id"];

export function isBandStyle(value: unknown): value is BandStyle {
  return BAND_STYLES.some((b) => b.id === value);
}

// ---- The small touches ------------------------------------------------------------------------------------------

export const WHIMSY_SEASONS = ["auto", "autumn", "winter", "spring", "summer", "none"] as const;
export type WhimsySeason = (typeof WHIMSY_SEASONS)[number];
export const WHIMSY_MARKERS = ["diamond", "star", "heart", "leaf", "dot"] as const;
export type WhimsyMarker = (typeof WHIMSY_MARKERS)[number];

/** The co-op's choices for the sidebar's small pleasures (app/family-village/side-nav.tsx). */
export type Whimsy = {
  /** The time-of-day greeting at the top of the sidebar. */
  greeting: boolean;
  /** The engraved village at the foot of the sidebar. */
  village: boolean;
  /** What blows through the village: the season by the calendar, a fixed one, or nothing. */
  season: WhimsySeason;
  /** The shape that marks the current page (and ends the tab underline). */
  marker: WhimsyMarker;
  /** The quill underline under the current page's name. */
  quill: boolean;
  /** The springs, wiggles and falling things. Off is the same as the device's reduced-motion setting. */
  motion: boolean;
};

export const DEFAULT_WHIMSY: Whimsy = { greeting: true, village: true, season: "auto", marker: "diamond", quill: true, motion: true };

export function parseWhimsy(value: unknown): Whimsy {
  const w = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    greeting: flag(w.greeting, DEFAULT_WHIMSY.greeting),
    village: flag(w.village, DEFAULT_WHIMSY.village),
    season: (WHIMSY_SEASONS as readonly string[]).includes(w.season as string) ? (w.season as WhimsySeason) : DEFAULT_WHIMSY.season,
    marker: (WHIMSY_MARKERS as readonly string[]).includes(w.marker as string) ? (w.marker as WhimsyMarker) : DEFAULT_WHIMSY.marker,
    quill: flag(w.quill, DEFAULT_WHIMSY.quill),
    motion: flag(w.motion, DEFAULT_WHIMSY.motion),
  };
}

// ---- Logos -----------------------------------------------------------------------------------------------------

export const LOGO_SLOTS = ["logo_light", "logo_dark", "mark_light", "mark_dark"] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

/** The custom property each logo slot sets; unset, the stylesheet's own default (the files in public/brand). */
export const LOGO_VARS: Record<LogoSlot, string> = {
  logo_light: "--coop-lockup-light",
  logo_dark: "--coop-lockup-dark",
  mark_light: "--coop-mark-light",
  mark_dark: "--coop-mark-dark",
};

export const LOGO_BUCKET = "coop-brand";
export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Only public files in the co-op's brand bucket are ever used as a logo (the same rule as the pre-paint script). */
export const LOGO_URL_RE = /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/storage\/v1\/object\/public\/coop-brand\/[A-Za-z0-9_./-]+$/;

// ---- The theme as the page uses it ----------------------------------------------------------------------------

export const DEFAULT_COOP_NAME = "Veritas Village";

/** What a page needs to dress itself; also what is cached on the device (COOP_THEME_KEY). */
export type CoopTheme = {
  v: 1;
  name: string;
  paletteId: string;
  accent: AccentTokens;
  font: HeadingFontId;
  bodyFont: BodyFontId;
  header: BandStyle;
  sidebar: BandStyle;
  whimsy: Whimsy;
  logos: Partial<Record<LogoSlot, string>>;
  /** The light lockup's width / height, so a co-op's own logo keeps its shape. */
  ratio: number | null;
  supportEmail: string | null;
  supportPhone: string | null;
  /** The ready-made palettes each person may pick for themselves (Account settings, Appearance). */
  personalPalettes: string[];
  /** Seasonal logo variants (Admin, Appearance; public.coop_logo_variants). */
  seasonal: LogoVariant[];
  /** The co-op's time zone, for which day it is. Fixed for now (lib/coop-time.ts COOP_TZ); a setting later (#139). */
  timeZone: string;
};

export const DEFAULT_PERSONAL_PALETTES = PALETTES.map((p) => p.id);
export const DEFAULT_TIME_ZONE = "America/Chicago";

export const DEFAULT_THEME: CoopTheme = {
  v: 1, name: DEFAULT_COOP_NAME, paletteId: DEFAULT_PALETTE_ID, accent: VERITAS_ACCENT, font: DEFAULT_HEADING_FONT,
  bodyFont: DEFAULT_BODY_FONT, header: "plain", sidebar: "plain", whimsy: DEFAULT_WHIMSY,
  logos: {}, ratio: null, supportEmail: null, supportPhone: null, personalPalettes: DEFAULT_PERSONAL_PALETTES,
  seasonal: [], timeZone: DEFAULT_TIME_ZONE,
};

// ---- Personal appearance ----------------------------------------------------------------------------------------
// Each person may choose one of the co-op's allowed ready-made palettes instead of the co-op's own, and larger text
// (lib/personal-appearance.ts keeps the choices). Only ready-made palettes: they all pass every check.

export const PERSONAL_ACCENT_KEY = "vv-accent";
export const TEXT_SIZE_KEY = "vv-text-size";
export const TEXT_SIZES = ["normal", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
/** How much "Larger text" scales every font size and line height (app/appearance.css, --text-scale). */
export const LARGE_TEXT_SCALE = 1.15;

/** The accent in force: the person's palette when the co-op allows it, else the co-op's own. */
export function effectiveAccent(theme: CoopTheme, personal: unknown): AccentTokens {
  if (typeof personal === "string" && theme.personalPalettes.includes(personal)) {
    const palette = paletteById(personal);
    if (palette) return palette.tokens;
  }
  return theme.accent;
}

export const COOP_THEME_KEY = "vv-coop";

// ---- Seasonal logos (part 3, issue #110) ---------------------------------------------------------------------------

export type LogoVariant = {
  name: string;
  /** "YYYY-MM-DD". With `yearly` only the month and day count, and the range may run over New Year. */
  startsOn: string;
  endsOn: string;
  yearly: boolean;
  /** "auto": between the dates; "on": now, whatever the date; "off": never. */
  override: "auto" | "on" | "off";
  logos: Partial<Record<LogoSlot, string>>;
  ratio: number | null;
  updatedAt: string;
};

/**
 * The variant in force on `today` ("YYYY-MM-DD" in the co-op's time zone), or null. One turned on wins (the most
 * recently changed, if several); otherwise the dated one whose range holds today, the shortest range first (a
 * one-day "Founders' Day" beats a month-long "Autumn"), then the most recently changed.
 *
 * Self-contained on purpose: COOP_SCRIPT carries its source (activeVariant.toString()) so the page before its first
 * paint and the page after it can never disagree.
 */
export function activeVariant(variants: LogoVariant[], today: string): LogoVariant | null {
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  const md = (iso: string) => iso.slice(5, 10);
  const span = (v: LogoVariant) => {
    if (!v.yearly) return day(v.endsOn) - day(v.startsOn);
    const d = day("2001-" + md(v.endsOn)) - day("2001-" + md(v.startsOn));
    return d >= 0 ? d : d + 365;
  };
  const holds = (v: LogoVariant) => {
    if (!v.yearly) return v.startsOn <= today && today <= v.endsOn;
    const s = md(v.startsOn), e = md(v.endsOn), t = md(today);
    return s <= e ? s <= t && t <= e : t >= s || t <= e;
  };
  const newer = (a: LogoVariant, b: LogoVariant) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0);
  const on = variants.filter((v) => v.override === "on").sort(newer);
  if (on.length) return on[0];
  const dated = variants.filter((v) => v.override === "auto" && holds(v)).sort((a, b) => span(a) - span(b) || newer(a, b));
  return dated.length ? dated[0] : null;
}

/** Today's date in the co-op's time zone, as "YYYY-MM-DD". */
export function coopToday(timeZone: string, now: Date = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
  catch { return now.toISOString().slice(0, 10); }
}

/**
 * The CSS custom properties a theme sets on the document. Nothing is set for a logo the co-op has not uploaded. A
 * seasonal variant in force on `today` replaces the slots it has; the others keep the co-op's own logo.
 */
export function themeVars(theme: CoopTheme, today: string = coopToday(theme.timeZone)): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of ACCENT_KEYS) vars[ACCENT_VARS[key]] = theme.accent[key];
  vars["--serif"] = HEADING_FONTS.find((f) => f.id === theme.font)?.stack ?? HEADING_FONTS[0].stack;
  vars["--sans"] = BODY_FONTS.find((f) => f.id === theme.bodyFont)?.stack ?? BODY_FONTS[0].stack;
  const season = activeVariant(theme.seasonal, today);
  const logos = { ...theme.logos, ...(season?.logos ?? {}) };
  for (const slot of LOGO_SLOTS) {
    const url = logos[slot];
    if (url && LOGO_URL_RE.test(url)) vars[LOGO_VARS[slot]] = `url("${url}")`;
  }
  const ratio = season?.logos.logo_light ? season.ratio : theme.ratio;
  if (ratio && ratio >= 1 && ratio <= 6) vars["--coop-lockup-ratio"] = String(Math.round(ratio * 1000) / 1000);
  return vars;
}

/**
 * The attributes a theme puts on <html> for the stylesheet (app/desktop-nav.css): the header and sidebar styles, the
 * marker's shape, and "off" for each small touch that is turned off. Keys are dataset names (data-coop-header...).
 */
export function themeDataset(theme: CoopTheme): Record<string, string> {
  const w = theme.whimsy;
  const data: Record<string, string> = { coopHeader: theme.header, coopSidebar: theme.sidebar, coopMarker: w.marker };
  if (!w.greeting) data.coopGreeting = "off";
  if (!w.village) data.coopVillage = "off";
  if (!w.quill) data.coopQuill = "off";
  if (!w.motion) data.coopMotion = "off";
  return data;
}

/** Every dataset key themeDataset may set, so a change of theme can clear what the new one leaves out. */
export const THEME_DATASET_KEYS = ["coopHeader", "coopSidebar", "coopMarker", "coopGreeting", "coopVillage", "coopQuill", "coopMotion"];

/** Every custom property a theme may set, so a change of theme can clear what the new one leaves out. */
export const THEME_VAR_NAMES = [...ACCENT_KEYS.map((k) => ACCENT_VARS[k]), "--serif", "--sans", ...LOGO_SLOTS.map((s) => LOGO_VARS[s]), "--coop-lockup-ratio"];

/**
 * Reads a cached or fetched theme defensively: anything malformed falls back to the default, and an accent is
 * taken whole or not at all (a half-applied palette was never checked).
 */
export function parseTheme(value: unknown): CoopTheme {
  if (!value || typeof value !== "object") return DEFAULT_THEME;
  const t = value as Record<string, unknown>;
  const accentIn = (t.accent ?? {}) as Record<string, unknown>;
  const accent = ACCENT_KEYS.every((k) => isHex(accentIn[k])) && checkAccent(accentIn).length === 0
    ? Object.fromEntries(ACCENT_KEYS.map((k) => [k, accentIn[k] as string])) as AccentTokens
    : VERITAS_ACCENT;
  const logosIn = (t.logos ?? {}) as Record<string, unknown>;
  const logos: Partial<Record<LogoSlot, string>> = {};
  for (const slot of LOGO_SLOTS) { const u = logosIn[slot]; if (typeof u === "string" && LOGO_URL_RE.test(u)) logos[slot] = u; }
  const ratio = typeof t.ratio === "number" && t.ratio >= 1 && t.ratio <= 6 ? t.ratio : null;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return {
    v: 1,
    name: text(t.name, 80) ?? DEFAULT_COOP_NAME,
    paletteId: typeof t.paletteId === "string" ? t.paletteId : DEFAULT_PALETTE_ID,
    accent,
    font: isHeadingFont(t.font) ? t.font : DEFAULT_HEADING_FONT,
    bodyFont: isBodyFont(t.bodyFont) ? t.bodyFont : DEFAULT_BODY_FONT,
    header: isBandStyle(t.header) ? t.header : "plain",
    sidebar: isBandStyle(t.sidebar) ? t.sidebar : "plain",
    whimsy: parseWhimsy(t.whimsy),
    logos,
    ratio,
    supportEmail: text(t.supportEmail, 200),
    supportPhone: text(t.supportPhone, 40),
    personalPalettes: Array.isArray(t.personalPalettes)
      ? t.personalPalettes.filter((id): id is string => typeof id === "string" && Boolean(paletteById(id)))
      : DEFAULT_PERSONAL_PALETTES,
    seasonal: Array.isArray(t.seasonal) ? t.seasonal.map(parseVariant).filter((v): v is LogoVariant => v !== null).slice(0, 24) : [],
    timeZone: typeof t.timeZone === "string" && /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(t.timeZone) ? t.timeZone : DEFAULT_TIME_ZONE,
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function parseVariant(value: unknown): LogoVariant | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.startsOn !== "string" || !ISO_DAY.test(v.startsOn) || typeof v.endsOn !== "string" || !ISO_DAY.test(v.endsOn)) return null;
  if (v.override !== "auto" && v.override !== "on" && v.override !== "off") return null;
  const logosIn = (v.logos ?? {}) as Record<string, unknown>;
  const logos: Partial<Record<LogoSlot, string>> = {};
  for (const slot of LOGO_SLOTS) { const u = logosIn[slot]; if (typeof u === "string" && LOGO_URL_RE.test(u)) logos[slot] = u; }
  if (!Object.keys(logos).length) return null;
  return {
    name: typeof v.name === "string" ? v.name.slice(0, 60) : "",
    startsOn: v.startsOn, endsOn: v.endsOn, yearly: v.yearly === true, override: v.override, logos,
    ratio: typeof v.ratio === "number" && v.ratio >= 1 && v.ratio <= 6 ? v.ratio : null,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

/** The settings row (public.coop_settings) as a theme. `publicUrl` turns a bucket path into its public URL. */
export function themeFromRow(row: Record<string, unknown> | null | undefined, publicUrl: (path: string) => string, variantRows: Record<string, unknown>[] = []): CoopTheme {
  if (!row) return DEFAULT_THEME;
  const seasonal = variantRows.map((r) => {
    const vlogos: Record<string, string> = {};
    for (const slot of LOGO_SLOTS) { const p = r[`${slot}_path`]; if (typeof p === "string" && p) vlogos[slot] = publicUrl(p); }
    return { name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, yearly: r.yearly, override: r.override, logos: vlogos,
      ratio: r.logo_ratio == null ? null : Number(r.logo_ratio), updatedAt: r.updated_at };
  });
  const logos: Record<string, string> = {};
  for (const slot of LOGO_SLOTS) {
    const path = row[`${slot}_path`];
    if (typeof path === "string" && path) logos[slot] = publicUrl(path);
  }
  return parseTheme({
    name: row.name, paletteId: row.palette_id, accent: row.accent, font: row.heading_font,
    bodyFont: row.body_font, header: row.header_style, sidebar: row.sidebar_style, whimsy: row.whimsy, logos,
    ratio: typeof row.logo_ratio === "number" ? row.logo_ratio : row.logo_ratio == null ? null : Number(row.logo_ratio),
    supportEmail: row.support_email, supportPhone: row.support_phone,
    personalPalettes: Array.isArray(row.personal_palettes) ? row.personal_palettes : undefined,
    seasonal,
  });
}

/**
 * Runs in the document head before the first paint (app/layout.tsx), after THEME_SCRIPT: dresses the page in the
 * co-op's cached palette, fonts, header and sidebar styles, small touches and logos so nothing flashes in the default look first. Plain old JavaScript on
 * purpose. The cache only ever holds what parseTheme accepted; the script still applies an accent whole or not at
 * all, and a logo only from the brand bucket.
 * With nothing cached (a first visit) the stylesheet's own defaults show until lib/coop-settings.ts has fetched.
 * It also applies the person's own choices kept on this device: larger text (always), and their palette when the
 * cached co-op settings allow it (effectiveAccent).
 */
export const COOP_SCRIPT = `(function(){try{var raw=null,pa=null,ts=null;try{raw=localStorage.getItem('${COOP_THEME_KEY}');pa=localStorage.getItem('${PERSONAL_ACCENT_KEY}');ts=localStorage.getItem('${TEXT_SIZE_KEY}')}catch(e){}
if(ts==='large')document.documentElement.dataset.textSize='large';
if(!raw)return;var t=JSON.parse(raw);if(!t||t.v!==1)return;
var s=document.documentElement.style,hex=${HEX_RE.toString()},keys=${JSON.stringify(ACCENT_KEYS)},vars=${JSON.stringify(ACCENT_KEYS.map((k) => ACCENT_VARS[k]))},a=t.accent||{},ok=true,i;
var P=${JSON.stringify(Object.fromEntries(PALETTES.map((p) => [p.id, p.tokens])))};
if(typeof pa==='string'&&P.hasOwnProperty(pa)&&Object.prototype.toString.call(t.personalPalettes)==='[object Array]'&&t.personalPalettes.indexOf(pa)>=0)a=P[pa];
for(i=0;i<keys.length;i++){if(typeof a[keys[i]]!=='string'||!hex.test(a[keys[i]]))ok=false}
if(ok){for(i=0;i<keys.length;i++)s.setProperty(vars[i],a[keys[i]])}
var fonts=${JSON.stringify(Object.fromEntries(HEADING_FONTS.map((f) => [f.id, f.stack])))};
if(typeof t.font==='string'&&fonts.hasOwnProperty(t.font))s.setProperty('--serif',fonts[t.font]);
var bodies=${JSON.stringify(Object.fromEntries(BODY_FONTS.map((f) => [f.id, f.stack])))};
if(typeof t.bodyFont==='string'&&bodies.hasOwnProperty(t.bodyFont))s.setProperty('--sans',bodies[t.bodyFont]);
var d=document.documentElement.dataset,bands=${JSON.stringify(BAND_STYLES.map((b) => b.id))},marks=${JSON.stringify(WHIMSY_MARKERS)},w=t.whimsy||{};
if(bands.indexOf(t.header)>=0)d.coopHeader=t.header;if(bands.indexOf(t.sidebar)>=0)d.coopSidebar=t.sidebar;
if(marks.indexOf(w.marker)>=0)d.coopMarker=w.marker;
if(w.greeting===false)d.coopGreeting='off';if(w.village===false)d.coopVillage='off';if(w.quill===false)d.coopQuill='off';if(w.motion===false)d.coopMotion='off';
var re=${LOGO_URL_RE.toString()},slots=${JSON.stringify(LOGO_VARS)},L={},B=t.logos||{},ratio=t.ratio,season=null,k;
for(k in B)if(B.hasOwnProperty(k))L[k]=B[k];
if(Object.prototype.toString.call(t.seasonal)==='[object Array]'){
var today;try{today=new Intl.DateTimeFormat('en-CA',{timeZone:t.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}catch(e){today=new Date().toISOString().slice(0,10)}
var ok2=[];for(i=0;i<t.seasonal.length;i++){var v=t.seasonal[i];if(v&&typeof v.startsOn==='string'&&typeof v.endsOn==='string'&&v.logos)ok2.push(v)}
season=(${activeVariant.toString()})(ok2,today);
if(season){for(k in season.logos)if(season.logos.hasOwnProperty(k))L[k]=season.logos[k];if(season.logos.logo_light)ratio=season.ratio}}
for(k in slots){if(slots.hasOwnProperty(k)&&typeof L[k]==='string'&&re.test(L[k]))s.setProperty(slots[k],'url("'+L[k]+'")')}
if(typeof ratio==='number'&&ratio>=1&&ratio<=6)s.setProperty('--coop-lockup-ratio',String(Math.round(ratio*1000)/1000));
}catch(e){}})();`;
