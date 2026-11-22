/**
 * Ready-made looks (Admin, Appearance): whole themes an admin picks with one click and then adjusts. A look only fills
 * in the Appearance draft (palette, fonts, header and sidebar, the page's colours and the small touches); the name,
 * contact and logos stay as they are, and nothing is saved until Save. Every look is made of choices that pass on
 * their own, and tests/theme-contrast.test.mjs runs each through the full contrast pair list in both themes.
 */
import {
  DEFAULT_THEME, DEFAULT_WHIMSY, GROUNDS, INKS, NIGHTS, NIGHT_FROM_INK, bandFamily, nightFamily, paletteById,
  type BandStyle, type BodyFontId, type CoopTheme, type HeadingFontId, type Whimsy,
} from "./coop-theme";

export type Look = {
  id: string;
  label: string;
  hint: string;
  paletteId: string;
  font: HeadingFontId;
  bodyFont: BodyFontId;
  header: BandStyle;
  sidebar: BandStyle;
  /** For "Your own colour" bands. */
  headerHex?: string;
  sidebarHex?: string;
  inkId: string;
  groundId: string;
  /** A ready-made dark theme, or NIGHT_FROM_INK. */
  nightId: string;
  whimsy: Partial<Whimsy>;
};

export const LOOKS: Look[] = [
  {
    id: "classic", label: "Veritas classic", hint: "The portal as it has always looked: terracotta on parchment, navy ink.",
    paletteId: "veritas", font: "playfair", bodyFont: "inter", header: "plain", sidebar: "plain",
    inkId: "navy", groundId: "parchment", nightId: "navy-night", whimsy: {},
  },
  {
    id: "storybook", label: "Storybook village", hint: "Soft serif headings, a tinted header and little stars.",
    paletteId: "veritas", font: "fraunces", bodyFont: "nunito", header: "tint", sidebar: "plain",
    inkId: "navy", groundId: "parchment", nightId: "navy-night", whimsy: { marker: "star", season: "auto" },
  },
  {
    id: "lantern", label: "Lantern hour", hint: "Warm ochre and espresso, like a reading lamp at dusk.",
    paletteId: "marigold", font: "cormorant", bodyFont: "source-sans", header: "ink", sidebar: "ink",
    inkId: "espresso", groundId: "parchment", nightId: "espresso-night", whimsy: { marker: "diamond" },
  },
  {
    id: "garden", label: "Garden path", hint: "Meadow green on sage mist, with a leafy sidebar.",
    paletteId: "meadow", font: "lora", bodyFont: "source-sans", header: "custom", headerHex: "#2e6b4f", sidebar: "tint",
    inkId: "forest", groundId: "sage", nightId: "forest-night", whimsy: { marker: "leaf", season: "spring" },
  },
  {
    id: "harbor", label: "Harbor", hint: "Sea blues on a cool page, sturdy and easy to read.",
    paletteId: "harbor", font: "merriweather", bodyFont: "open-sans", header: "ink", sidebar: "plain",
    inkId: "navy", groundId: "sky", nightId: "navy-night", whimsy: { marker: "dot" },
  },
  {
    id: "berry", label: "Berry and blush", hint: "Rounded and cheerful: berry accents on a blush page.",
    paletteId: "berry", font: "quicksand", bodyFont: "nunito", header: "accent", sidebar: "plain",
    inkId: "plum", groundId: "blush", nightId: "plum-night", whimsy: { marker: "heart" },
  },
  {
    id: "scholar", label: "Midnight scholar", hint: "Old-style serif, indigo accents and a true black night.",
    paletteId: "indigo", font: "eb-garamond", bodyFont: "literata", header: "plain", sidebar: "ink",
    inkId: "charcoal", groundId: "white", nightId: "black", whimsy: { marker: "diamond", season: "winter" },
  },
  {
    id: "modern", label: "Clean and modern", hint: "Plain white, slate and charcoal, with the small touches turned off.",
    paletteId: "slate", font: "montserrat", bodyFont: "inter", header: "plain", sidebar: "plain",
    inkId: "charcoal", groundId: "white", nightId: "charcoal", whimsy: { greeting: false, village: false, quill: false, marker: "dot", season: "none" },
  },
  {
    id: "lakeside", label: "Lakeside", hint: "Teal and deep teal, with a custom lake-blue sidebar.",
    paletteId: "teal", font: "source-serif", bodyFont: "atkinson", header: "plain", sidebar: "custom", sidebarHex: "#1f5e6e",
    inkId: "teal", groundId: "snow", nightId: NIGHT_FROM_INK, whimsy: { marker: "dot", season: "summer" },
  },
];

/** The theme a look gives, on top of `base` (which keeps its name, contact, logos and seasons). */
export function lookTheme(look: Look, base: CoopTheme = DEFAULT_THEME): CoopTheme {
  const palette = paletteById(look.paletteId);
  const ink = INKS.find((i) => i.id === look.inkId)?.value ?? null;
  const ground = GROUNDS.find((g) => g.id === look.groundId)?.value ?? null;
  const night = look.nightId === NIGHT_FROM_INK ? nightFamily(ink ?? "#0b2a3d") : NIGHTS.find((n) => n.id === look.nightId)?.value ?? null;
  return {
    ...base,
    paletteId: look.paletteId,
    accent: palette ? palette.tokens : base.accent,
    font: look.font,
    bodyFont: look.bodyFont,
    header: look.header,
    sidebar: look.sidebar,
    headerBand: look.headerHex ? bandFamily(look.headerHex) : base.headerBand,
    sidebarBand: look.sidebarHex ? bandFamily(look.sidebarHex) : base.sidebarBand,
    inkId: look.inkId, ink: look.inkId === "navy" ? null : ink,
    groundId: look.groundId, ground: look.groundId === "parchment" ? null : ground,
    nightId: look.nightId, night: look.nightId === "navy-night" ? null : night,
    whimsy: { ...DEFAULT_WHIMSY, ...look.whimsy },
  };
}
