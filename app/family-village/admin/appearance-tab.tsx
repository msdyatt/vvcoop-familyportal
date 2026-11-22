"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  BAND_STYLES, BODY_FONTS, CUSTOM_PALETTE_ID, DEFAULT_THEME, DEFAULT_WHIMSY, HEADING_FONTS, LOGO_BUCKET, LOGO_SLOTS, LOGO_TYPES, LOGO_VARS, PALETTES,
  WHIMSY_MARKERS, CUSTOM_CHOICE, GROUNDS, INKS, NIGHTS, NIGHT_FROM_INK, VERITAS_INK, checkInk, groundFamily, nearestUsableInk, nightFamily, bandFamily, bandTone, checkAccent, checkBand, generateAccent, nearestUsableBand, parseBand, isBandStyle, isBodyFont, isHeadingFont, nearestUsableAccent, normalizeHex, paletteById, parseWhimsy, themeVars,
  type AccentTokens, type BandStyle, type BandTokens, type GroundTokens, type NightTokens, type BodyFontId, type CoopTheme, type HeadingFontId, type LogoSlot, type Whimsy, type WhimsyMarker, type WhimsySeason,
} from "../../../lib/coop-theme";
import { COOP_SETTINGS_COLUMNS, brandFileUrl, fetchCoopTheme, setCoopTheme } from "../../../lib/coop-settings";
import { logoProblem } from "../../../lib/logo-files";
import SeasonalLogosCard from "./seasonal-logos-card";
import { LOOKS, lookTheme, type Look } from "../../../lib/coop-looks";

/**
 * Admin, Appearance: the co-op's name, support contact, accent palette, fonts, header and sidebar, small touches and logos (issue #140,
 * docs/theming.md "Co-op theme"). Everything is a draft until Save: the preview shows it in the light and the dark
 * theme side by side, and a palette that fails a contrast check cannot be saved (the database checks again).
 */

type Row = {
  name: string; palette_id: string; accent: AccentTokens; heading_font: string;
  body_font: string | null; header_style: string | null; sidebar_style: string | null; whimsy: unknown;
  header_band: unknown; sidebar_band: unknown;
  ink: string | null; ink_id: string | null; ground: GroundTokens | null; ground_id: string | null; night: NightTokens | null; night_id: string | null;
  logo_light_path: string | null; logo_dark_path: string | null; mark_light_path: string | null; mark_dark_path: string | null;
  logo_ratio: number | null; support_email: string | null; support_phone: string | null;
  personal_palettes: string[] | null;
};

/** A logo slot's draft: unchanged, a new file (with its preview URL and shape), or cleared back to the bundled logo. */
type LogoDraft = { kind: "keep" } | { kind: "new"; file: File; url: string; ratio: number } | { kind: "clear" };

const SLOT_LABELS: Record<LogoSlot, { title: string; hint: string }> = {
  logo_light: { title: "Logo for light backgrounds", hint: "The full logo with the name, in a dark ink. Shown in the header, on sign-in and in emails." },
  logo_dark: { title: "Logo for dark backgrounds", hint: "The same logo in a light ink, for the dark theme and the Admin band." },
  mark_light: { title: "Compact mark, light backgrounds", hint: "A small square version without the name." },
  mark_dark: { title: "Compact mark, dark backgrounds", hint: "The square mark in a light ink." },
};

export default function AppearanceTab() {
  const [row, setRow] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [supportPhone, setSupportPhone] = useState("");
  const [paletteId, setPaletteId] = useState("veritas");
  const [customHex, setCustomHex] = useState("#bb6141");
  const [font, setFont] = useState<HeadingFontId>("playfair");
  const [bodyFont, setBodyFont] = useState<BodyFontId>("inter");
  const [header, setHeader] = useState<BandStyle>("plain");
  const [sidebar, setSidebar] = useState<BandStyle>("plain");
  // "Your own colour" for each band, as typed (the rest of its colours are worked out from it).
  const [headerHex, setHeaderHex] = useState("#2e6b4f");
  const [sidebarHex, setSidebarHex] = useState("#2e6b4f");
  // The page's colours: a ready-made choice or your own (ink as typed; page and dark theme from a colour's hue).
  const [inkId, setInkId] = useState("navy");
  const [inkHex, setInkHex] = useState(VERITAS_INK);
  const [groundId, setGroundId] = useState("parchment");
  const [groundHex, setGroundHex] = useState("#6f9a6c");
  const [nightId, setNightId] = useState("navy-night");
  const [nightHex, setNightHex] = useState("#1d5a40");
  const [whimsy, setWhimsy] = useState<Whimsy>(DEFAULT_WHIMSY);
  const [logos, setLogos] = useState<Record<LogoSlot, LogoDraft>>({ logo_light: { kind: "keep" }, logo_dark: { kind: "keep" }, mark_light: { kind: "keep" }, mark_dark: { kind: "keep" } });
  const [logoErrors, setLogoErrors] = useState<Partial<Record<LogoSlot, string>>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [personal, setPersonal] = useState<string[]>([]);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("coop_settings").select(COOP_SETTINGS_COLUMNS).eq("id", "coop").maybeSingle();
    if (error || !data) { setLoadError(error?.message ?? "The co-op settings could not be loaded."); return; }
    const r = data as unknown as Row;
    setRow(r);
    setName(r.name);
    setSupportEmail(r.support_email ?? "");
    setSupportPhone(r.support_phone ?? "");
    setPaletteId(r.palette_id);
    setCustomHex(r.accent?.accent ?? "#bb6141");
    setFont(isHeadingFont(r.heading_font) ? r.heading_font : "playfair");
    setBodyFont(isBodyFont(r.body_font) ? r.body_font : "inter");
    setHeader(isBandStyle(r.header_style) ? r.header_style : "plain");
    setSidebar(isBandStyle(r.sidebar_style) ? r.sidebar_style : "plain");
    setHeaderHex(parseBand(r.header_band)?.bg ?? "#2e6b4f");
    setSidebarHex(parseBand(r.sidebar_band)?.bg ?? "#2e6b4f");
    setInkId(r.ink ? r.ink_id ?? CUSTOM_CHOICE : "navy");
    setInkHex(r.ink ?? VERITAS_INK);
    setGroundId(r.ground ? r.ground_id ?? CUSTOM_CHOICE : "parchment");
    if (r.ground) setGroundHex(r.ground.sunken);
    setNightId(r.night ? r.night_id ?? CUSTOM_CHOICE : "navy-night");
    if (r.night) setNightHex(r.night.band);
    setWhimsy(parseWhimsy(r.whimsy));
    setLogos({ logo_light: { kind: "keep" }, logo_dark: { kind: "keep" }, mark_light: { kind: "keep" }, mark_dark: { kind: "keep" } });
    setLogoErrors({});
    setPersonal(r.personal_palettes ?? PALETTES.map((p) => p.id));
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  const customBase = normalizeHex(customHex);
  const accent: AccentTokens | null = useMemo(() => {
    if (paletteId === CUSTOM_PALETTE_ID) return customBase ? generateAccent(customBase) : null;
    // A palette saved by an earlier version keeps its stored colours; a known one uses today's definition.
    return paletteById(paletteId)?.tokens ?? (row && row.palette_id === paletteId ? row.accent : null);
  }, [paletteId, customBase, row]);
  const problems = accent ? checkAccent(accent) : [];
  const nearest = paletteId === CUSTOM_PALETTE_ID && customBase && problems.length ? nearestUsableAccent(customBase) : null;
  // The page's colours as they would be saved (null: the Veritas one).
  const inkBase = normalizeHex(inkHex);
  const ink: string | null = inkId === CUSTOM_CHOICE ? inkBase : inkId === "navy" ? null : INKS.find((i) => i.id === inkId)?.value ?? null;
  const inkProblems = inkId === CUSTOM_CHOICE ? (inkBase ? checkInk(inkBase) : ["Type a colour as six hex digits, like #3d1220."]) : [];
  const groundBase = normalizeHex(groundHex), nightBase = normalizeHex(nightHex);
  const ground: GroundTokens | null = useMemo(() => groundId === CUSTOM_CHOICE ? (groundBase ? groundFamily(groundBase) : null)
    : groundId === "parchment" ? null : GROUNDS.find((g) => g.id === groundId)?.value ?? null, [groundId, groundBase]);
  const usableInk = inkProblems.length ? null : ink;
  const night: NightTokens | null = useMemo(() => nightId === NIGHT_FROM_INK ? nightFamily(usableInk ?? VERITAS_INK)
    : nightId === CUSTOM_CHOICE ? (nightBase ? nightFamily(nightBase) : null)
    : nightId === "navy-night" ? null : NIGHTS.find((n) => n.id === nightId)?.value ?? null, [nightId, nightBase, usableInk]);
  const headerBase = normalizeHex(headerHex), sidebarBase = normalizeHex(sidebarHex);
  const headerBand: BandTokens | null = useMemo(() => (headerBase ? bandFamily(headerBase) : null), [headerBase]);
  const sidebarBand: BandTokens | null = useMemo(() => (sidebarBase ? bandFamily(sidebarBase) : null), [sidebarBase]);
  const bandProblems = (style: BandStyle, band: BandTokens | null) => (style !== "custom" ? [] : band ? checkBand(band) : ["Type a colour as six hex digits, like #2e6b4f."]);
  const headerProblems = bandProblems(header, headerBand), sidebarProblems = bandProblems(sidebar, sidebarBand);
  /** What is stored for a band: the typed colour when it passes, else whatever was saved before. */
  const storedBand = (band: BandTokens | null, saved: unknown) => (band && checkBand(band).length === 0 ? band : parseBand(saved));

  /** The theme as it would look after Save, with the staged logos. */
  const draft: CoopTheme | null = useMemo(() => {
    if (!row || !accent) return null;
    const supabase = getSupabaseBrowserClient();
    const current: Partial<Record<LogoSlot, string>> = {};
    for (const slot of LOGO_SLOTS) {
      const d = logos[slot];
      const path = row[`${slot}_path`];
      if (d.kind === "new") current[slot] = d.url;
      else if (d.kind === "keep" && path && supabase) current[slot] = brandFileUrl(supabase, path);
    }
    const lightLogo = logos.logo_light;
    const ratio = lightLogo.kind === "new" ? lightLogo.ratio : lightLogo.kind === "clear" ? null : row.logo_ratio;
    const okBand = (b: BandTokens | null) => (b && checkBand(b).length === 0 ? b : null);
    return {
      ...DEFAULT_THEME, name: name.trim() || row.name, paletteId, accent, font, bodyFont, whimsy, logos: current, ratio,
      inkId, ink: usableInk, groundId, ground, nightId, night,
      // A band whose colour does not pass is previewed as Plain, which is what the page would fall back to.
      header: header === "custom" && !okBand(headerBand) ? "plain" : header, headerBand: okBand(headerBand),
      sidebar: sidebar === "custom" && !okBand(sidebarBand) ? "plain" : sidebar, sidebarBand: okBand(sidebarBand),
    };
  }, [row, accent, logos, name, paletteId, font, bodyFont, header, sidebar, headerBand, sidebarBand, whimsy, inkId, usableInk, groundId, ground, nightId, night]);

  /** Fills the draft with a ready-made look. The name, contact and logos stay; nothing is saved until Save. */
  function applyLook(look: Look) {
    setPaletteId(look.paletteId);
    setFont(look.font);
    setBodyFont(look.bodyFont);
    setHeader(look.header);
    setSidebar(look.sidebar);
    if (look.headerHex) setHeaderHex(look.headerHex);
    if (look.sidebarHex) setSidebarHex(look.sidebarHex);
    setInkId(look.inkId);
    setGroundId(look.groundId);
    setNightId(look.nightId);
    setWhimsy({ ...DEFAULT_WHIMSY, ...look.whimsy });
    setStatus(`The ${look.label} look is in the preview. Adjust anything below, then Save. Your name, contact and logos are unchanged.`);
  }

  async function pickLogo(slot: LogoSlot, file: File | undefined) {
    if (!file) return;
    const result = await logoProblem(slot, file).catch((e: Error) => e.message);
    if (typeof result === "string") { setLogoErrors((e) => ({ ...e, [slot]: result })); return; }
    if (result === null) return;
    setLogoErrors((e) => ({ ...e, [slot]: undefined }));
    setLogos((l) => {
      const old = l[slot];
      if (old.kind === "new") URL.revokeObjectURL(old.url);
      return { ...l, [slot]: { kind: "new", file, url: URL.createObjectURL(file), ratio: result.ratio } };
    });
  }

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !row || !accent) return;
    if (problems.length) { setStatus("This palette cannot be saved yet: fix the contrast problems listed under it."); return; }
    if (!name.trim()) { setStatus("Give the co-op a name."); return; }
    if (inkProblems.length) { setStatus("The ink colour cannot be saved yet: see the note under it."); return; }
    if (headerProblems.length || sidebarProblems.length) { setStatus("A header or sidebar colour cannot be saved yet: see the note under it."); return; }
    setBusy(true);
    setStatus("Saving…");
    try {
      const replaced: string[] = [];
      for (const slot of LOGO_SLOTS) {
        const d = logos[slot];
        const oldPath = row[`${slot}_path`];
        if (d.kind === "keep") continue;
        let path: string | null = null;
        if (d.kind === "new") {
          const ext = d.file.type === "image/png" ? "png" : d.file.type === "image/webp" ? "webp" : "jpg";
          path = `${slot}/${crypto.randomUUID().replaceAll("-", "")}.${ext}`;
          const { error: upErr } = await supabase.storage.from(LOGO_BUCKET).upload(path, d.file, { contentType: d.file.type, cacheControl: "31536000", upsert: false });
          if (upErr) throw new Error(`The ${SLOT_LABELS[slot].title.toLowerCase()} could not be uploaded: ${upErr.message}`);
        }
        const { error } = await supabase.rpc("admin_set_coop_logo", { p_slot: slot, p_path: path, p_ratio: d.kind === "new" && slot === "logo_light" ? d.ratio : null });
        if (error) throw new Error(error.message);
        if (oldPath) replaced.push(oldPath);
      }
      const { error } = await supabase.rpc("admin_save_coop_settings", {
        p_name: name, p_palette_id: paletteId, p_accent: accent, p_heading_font: font,
        p_support_email: supportEmail, p_support_phone: supportPhone,
      });
      if (error) throw new Error(error.message);
      const { error: styleError } = await supabase.rpc("admin_save_coop_style", {
        p_body_font: bodyFont, p_header_style: header, p_sidebar_style: sidebar, p_whimsy: whimsy,
        p_header_band: storedBand(headerBand, row.header_band), p_sidebar_band: storedBand(sidebarBand, row.sidebar_band),
      });
      if (styleError) throw new Error(styleError.message);
      const { error: pageError } = await supabase.rpc("admin_save_coop_page", {
        p_ink_id: inkId, p_ink: ink, p_ground_id: groundId, p_ground: ground, p_night_id: nightId, p_night: night,
      });
      if (pageError) throw new Error(pageError.message);
      const personalNow = PALETTES.map((p) => p.id).filter((id) => personal.includes(id));
      if (JSON.stringify(personalNow) !== JSON.stringify(row.personal_palettes ?? PALETTES.map((p) => p.id))) {
        const { error: personalError } = await supabase.rpc("admin_set_personal_palettes", { p_ids: personalNow });
        if (personalError) throw new Error(personalError.message);
      }
      // The old files are no longer used. Removing them is tidy-up; a failure here changes nothing people see.
      if (replaced.length) await supabase.storage.from(LOGO_BUCKET).remove(replaced).catch(() => {});
      const theme = await fetchCoopTheme(supabase);
      if (theme) setCoopTheme(theme);
      await load();
      setStatus("Saved. Everyone sees the new look the next time a page opens.");
    } catch (e) {
      setStatus((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !row) return;
    setConfirmReset(false);
    setBusy(true);
    const old = LOGO_SLOTS.map((s) => row[`${s}_path`]).filter((p): p is string => Boolean(p));
    const { error } = await supabase.rpc("admin_reset_coop_appearance");
    if (error) { setStatus(error.message); setBusy(false); return; }
    if (old.length) await supabase.storage.from(LOGO_BUCKET).remove(old).catch(() => {});
    const theme = await fetchCoopTheme(supabase);
    if (theme) setCoopTheme(theme);
    await load();
    setBusy(false);
    setStatus("Back to the Veritas Village palette, fonts, plain header and sidebar, every small touch, and the bundled logos. The name and contact are unchanged.");
  }

  if (loadError) return <section className="appearance"><p className="admin-form-status" role="alert">{loadError}</p></section>;
  if (!row) return <section className="appearance"><p className="admin-form-status" role="status">Loading…</p></section>;

  return <section className="appearance">
    <div className="appearance-editor">
      <section className="appearance-card">
        <p className="card-kicker">Ready-made looks</p>
        <p className="field-note">A whole look in one click: palette, fonts, header and sidebar, page colours and small touches. It fills in everything below for you to adjust; nothing changes for anyone until you save.</p>
        <div className="appearance-looks">
          {LOOKS.map((look) => <button type="button" key={look.id} className="appearance-look" disabled={busy} onClick={() => applyLook(look)}>
            <LookSwatch look={look} />
            <span><b>{look.label}</b><small>{look.hint}</small></span>
          </button>)}
        </div>
      </section>

      <section className="appearance-card">
        <p className="card-kicker">The co-op</p>
        <label>Name<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={busy} /></label>
        <p className="field-note">Shown in the header, on sign-in, in emails and in text messages.</p>
        <label>Support email <span>optional</span><input type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="office@example.org" disabled={busy} /></label>
        <label>Support phone <span>optional</span><input type="tel" value={supportPhone} onChange={(e) => setSupportPhone(e.target.value)} placeholder="(555) 010-0100" disabled={busy} /></label>
        <p className="field-note">Where families are told to ask for help.</p>
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Accent colour</p>
        <p className="field-note">Used for rules, links, highlights and, in the dark theme, buttons. Ink, backgrounds, alerts and errors stay as they are.</p>
        <div className="appearance-palettes" role="radiogroup" aria-label="Accent palette">
          {PALETTES.map((p) => <button type="button" key={p.id} role="radio" aria-checked={paletteId === p.id} disabled={busy}
            className="appearance-palette" onClick={() => setPaletteId(p.id)}>
            <span className="appearance-swatches" aria-hidden="true">
              <span style={{ background: p.tokens.accent }} /><span style={{ background: p.tokens.accent_text }} /><span style={{ background: p.tokens.night_fill }} /><span style={{ background: p.tokens.accent_tint }} />
            </span>
            {p.label}
          </button>)}
          <button type="button" role="radio" aria-checked={paletteId === CUSTOM_PALETTE_ID} disabled={busy} className="appearance-palette" onClick={() => setPaletteId(CUSTOM_PALETTE_ID)}>
            <span className="appearance-swatches" aria-hidden="true"><span style={{ background: customBase ?? "transparent" }} /></span>
            Your own colour
          </button>
        </div>
        {paletteId === CUSTOM_PALETTE_ID && <div className="appearance-custom">
          <label>Colour<input type="color" value={customBase ?? "#bb6141"} onChange={(e) => setCustomHex(e.target.value)} disabled={busy} /></label>
          <label>Hex<input value={customHex} onChange={(e) => setCustomHex(e.target.value)} placeholder="#4f8a55" spellCheck={false} disabled={busy} /></label>
          {!customBase && <p className="appearance-problem" role="alert">Type a colour as six hex digits, like #4f8a55.</p>}
          <p className="field-note">The lighter and darker versions for text and the dark theme are worked out from it and checked automatically.</p>
        </div>}
        {problems.length > 0 && <div className="appearance-problems" role="alert">
          <p><strong>This colour cannot be used as it is.</strong></p>
          <ul>{problems.map((p) => <li key={p.message}>{p.message}</li>)}</ul>
          {nearest && <button type="button" className="ghost" onClick={() => setCustomHex(nearest)}>Use the nearest shade that works ({nearest})</button>}
        </div>}
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Colours members may choose</p>
        <p className="field-note">Each person can switch to one of these for themselves under Account settings, Appearance. The co-op&rsquo;s own colours are always offered. Untick them all to keep one palette for everyone.</p>
        <div className="appearance-personal">
          {PALETTES.map((p) => <label key={p.id}>
            <input type="checkbox" checked={personal.includes(p.id)} disabled={busy}
              onChange={(e) => setPersonal((list) => e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id))} />
            <span className="appearance-swatches" aria-hidden="true"><span style={{ background: p.tokens.accent }} /></span>
            {p.label}
          </label>)}
        </div>
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Fonts</p>
        <p className="field-note">Every font here is kept with the portal, so nothing is loaded from anyone else. A device only downloads the ones in use.</p>
        <FontPicker id="appearance-heading-font" label="Headings" fonts={HEADING_FONTS} value={font} disabled={busy}
          onChange={(id) => { if (isHeadingFont(id)) setFont(id); }} sample={name.trim() || row.name} large />
        <FontPicker id="appearance-body-font" label="Text" fonts={BODY_FONTS} value={bodyFont} disabled={busy}
          onChange={(id) => { if (isBodyFont(id)) setBodyFont(id); }} sample="Friday is co-op day. Doors open at 9:45, so pack lunches the night before." />
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Page colours</p>
        <p className="field-note">The ink is the deep colour of text, primary buttons, selected tabs and the Admin band. It can be any colour at least as deep as navy; the page can be any colour at least as light as parchment, and the dark theme any ground at least as deep as navy night. That rule keeps every palette readable with every choice.</p>
        <PageChoice label="Ink" value={inkId} onChange={setInkId} disabled={busy}
          options={INKS.map((i) => ({ id: i.id, label: i.label, swatch: i.value }))}
          custom={{ hex: inkHex, setHex: setInkHex, problems: inkProblems, nearest: inkBase && inkProblems.length ? nearestUsableInk(inkBase) : null,
            note: "Any colour at least as deep as navy." }} />
        <PageChoice label="Page background" value={groundId} onChange={setGroundId} disabled={busy}
          options={GROUNDS.map((g) => ({ id: g.id, label: g.label, swatch: `linear-gradient(135deg, ${g.value.ground} 55%, ${g.value.panel} 55%)` }))}
          custom={{ hex: groundHex, setHex: setGroundHex, problems: [], nearest: null, label: "Your own tint",
            note: "A pale tint of this colour's hue, as light as the portal needs." }} />
        <PageChoice label="Dark theme" value={nightId} onChange={setNightId} disabled={busy}
          options={[...NIGHTS.map((n) => ({ id: n.id, label: n.label, swatch: `linear-gradient(135deg, ${n.value.canvas} 55%, ${n.value.band} 55%)` })),
            { id: NIGHT_FROM_INK, label: "From the ink", swatch: (() => { const n = nightFamily(usableInk ?? VERITAS_INK); return `linear-gradient(135deg, ${n.canvas} 55%, ${n.band} 55%)`; })() }]}
          custom={{ hex: nightHex, setHex: setNightHex, problems: [], nearest: null, label: "Your own night",
            note: "A deep ground in this colour's hue, as deep as the portal needs." }} />
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Header and sidebar</p>
        <p className="field-note">The ready styles only use colour pairs that are already checked. With your own colour, the text on it is cream or navy, whichever reads better, and it is checked before saving; in the dark theme a light colour becomes a deep version of itself. Admin keeps its navy band.</p>
        <BandPicker which="header" label="Header" value={header} onChange={setHeader} disabled={busy} swatchStyle={draft ? themeVarsStyle(draft) : undefined}
          hex={headerHex} setHex={setHeaderHex} band={headerBand} problems={headerProblems} />
        <BandPicker which="sidebar" label="Sidebar" value={sidebar} onChange={setSidebar} disabled={busy} swatchStyle={draft ? themeVarsStyle(draft) : undefined}
          hex={sidebarHex} setHex={setSidebarHex} band={sidebarBand} problems={sidebarProblems} />
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Small touches</p>
        <p className="field-note">The little things in the sidebar. Anyone who has asked their device for less motion never sees the animations.</p>
        <label className="appearance-select">What blows through the village
          <select value={whimsy.season} disabled={busy} onChange={(e) => setWhimsy((w) => ({ ...w, season: e.target.value as WhimsySeason }))}>
            <option value="auto">The season, by the calendar</option>
            <option value="autumn">Autumn leaves, all year</option>
            <option value="winter">Winter snow, all year</option>
            <option value="spring">Spring petals, all year</option>
            <option value="summer">Summer fireflies, all year</option>
            <option value="none">Nothing</option>
          </select>
        </label>
        <fieldset className="appearance-markers">
          <legend>The mark beside the current page</legend>
          <div role="radiogroup" aria-label="Mark shape">
            {WHIMSY_MARKERS.map((m) => <button type="button" key={m} role="radio" aria-checked={whimsy.marker === m} disabled={busy}
              className="appearance-marker" onClick={() => setWhimsy((w) => ({ ...w, marker: m }))}>
              <span className="appearance-marker-glyph" data-marker={m} aria-hidden="true" />{MARKER_LABELS[m]}
            </button>)}
          </div>
        </fieldset>
        <div className="appearance-toggles">
          {TOUCHES.map((t) => <label key={t.key}>
            <input type="checkbox" checked={whimsy[t.key]} disabled={busy} onChange={(e) => setWhimsy((w) => ({ ...w, [t.key]: e.target.checked }))} />
            <b>{t.label}</b>
            <small>{t.hint}</small>
          </label>)}
        </div>
      </section>

      <section className="appearance-card">
        <p className="card-kicker">Logos</p>
        <p className="field-note">PNG, JPEG or WebP, up to 1 MB. Leave a slot empty to keep the Veritas Village logo there.</p>
        {LOGO_SLOTS.map((slot) => {
          const d = logos[slot];
          const has = d.kind === "new" || (d.kind === "keep" && Boolean(row[`${slot}_path`]));
          return <div className="appearance-logo-slot" key={slot}>
            <div className={`appearance-logo-thumb ${slot.endsWith("dark") ? "on-dark" : "on-light"}`}>
              <span className={`coop-logo ${slot.startsWith("logo") ? "lockup" : "mark"} ${slot.endsWith("dark") ? "on-dark" : "on-light"}`}
                style={draft ? (themeVarsStyle(draft)) : undefined} aria-hidden="true" />
            </div>
            <div>
              <p className="appearance-logo-title">{SLOT_LABELS[slot].title}</p>
              <p className="field-note">{SLOT_LABELS[slot].hint}{!has && " Using the bundled logo."}</p>
              <label className="appearance-upload">{has ? "Replace" : "Upload"}
                <input type="file" accept={LOGO_TYPES.join(",")} disabled={busy} onChange={(e) => { void pickLogo(slot, e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {has && <button type="button" className="ghost" disabled={busy} onClick={() => setLogos((l) => ({ ...l, [slot]: { kind: "clear" } }))}>Use the bundled logo</button>}
              {logoErrors[slot] && <p className="appearance-problem" role="alert">{logoErrors[slot]}</p>}
            </div>
          </div>;
        })}
      </section>

      <SeasonalLogosCard />
    </div>

    <aside className="appearance-preview-column" aria-label="Preview">
      <p className="card-kicker">Preview</p>
      {draft && <div className="appearance-previews">
        <Preview theme={draft} mode="light" />
        <Preview theme={draft} mode="dark" />
      </div>}
      <div className="appearance-actions">
        <button type="button" onClick={save} disabled={busy || !accent || problems.length > 0 || headerProblems.length > 0 || sidebarProblems.length > 0 || inkProblems.length > 0}>{busy ? "Working…" : "Save appearance"}</button>
        {!confirmReset
          ? <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>Reset to default</button>
          : <span className="appearance-confirm">Go back to the Veritas palette, fonts, styles, small touches and logos?
            <button type="button" className="ghost" onClick={reset}>Reset</button>
            <button type="button" className="ghost" onClick={() => setConfirmReset(false)}>Keep</button></span>}
      </div>
      <p className="admin-form-status" role="status">{status || "Nothing changes for anyone until you save."}</p>
    </aside>
  </section>;
}

const MARKER_LABELS: Record<WhimsyMarker, string> = { diamond: "Diamond", star: "Star", heart: "Heart", leaf: "Leaf", dot: "Dot" };

const TOUCHES: { key: "greeting" | "village" | "quill" | "motion"; label: string; hint: string }[] = [
  { key: "greeting", label: "Greeting", hint: "\u201cGood morning\u201d with a little sun, lantern or moon at the top of the sidebar." },
  { key: "village", label: "The village", hint: "The engraved village at the foot of the sidebar." },
  { key: "quill", label: "Quill underline", hint: "A hand-drawn line under the current page\u2019s name." },
  { key: "motion", label: "Little animations", hint: "The mark springing between pages, wiggling icons, falling leaves." },
];

/** A font list as a drop-down, grouped, with a live sample in the chosen face. */
function FontPicker({ id, label, fonts, value, onChange, sample, disabled, large = false }: {
  id: string; label: string; fonts: readonly { id: string; label: string; group: string; hint: string; stack: string }[];
  value: string; onChange: (id: string) => void; sample: string; disabled: boolean; large?: boolean;
}) {
  const groups = [...new Set(fonts.map((f) => f.group))];
  const current = fonts.find((f) => f.id === value) ?? fonts[0];
  return <div className="appearance-font-picker">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {groups.map((g) => <optgroup key={g} label={g}>
        {fonts.filter((f) => f.group === g).map((f) => <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>{f.label}</option>)}
      </optgroup>)}
    </select>
    <p className={`appearance-font-sample${large ? " large" : ""}`} style={{ fontFamily: current.stack }}>{sample}</p>
    <small>{current.hint}</small>
  </div>;
}

/** The band styles as small swatches, for the header or the sidebar, with a colour picker for "Your own colour". */
function BandPicker({ which, label, value, onChange, disabled, swatchStyle, hex, setHex, band, problems }: {
  which: "header" | "sidebar"; label: string; value: BandStyle; onChange: (b: BandStyle) => void; disabled: boolean; swatchStyle?: CSSProperties;
  hex: string; setHex: (h: string) => void; band: BandTokens | null; problems: string[];
}) {
  // The "Your own colour" swatch shows the typed colour even before that style is chosen.
  const own = band ? { [`--coop-${which}-bg`]: band.bg, [`--coop-${which}-fg`]: band.fg } as CSSProperties : {};
  const base = normalizeHex(hex);
  const nearest = value === "custom" && base && problems.length ? nearestUsableBand(base) : null;
  return <fieldset className="appearance-bands">
    <legend>{label}</legend>
    <div role="radiogroup" aria-label={`${label} style`}>
      {BAND_STYLES.map((b) => <button type="button" key={b.id} role="radio" aria-checked={value === b.id} disabled={disabled}
        className="appearance-band" onClick={() => onChange(b.id)}>
        {/* The swatch wears the draft palette in the light roles, so it shows what Save would give. */}
        <span className="appearance-band-swatch theme-preview-light" data-band={b.id} data-for={which} style={{ ...swatchStyle, ...own }} aria-hidden="true"><span>Aa</span></span>
        <span><b>{b.label}</b><small>{b.hint}</small></span>
      </button>)}
    </div>
    {value === "custom" && <div className="appearance-custom appearance-band-colour">
      <label>Colour<input type="color" value={base ?? "#2e6b4f"} onChange={(e) => setHex(e.target.value)} disabled={disabled} /></label>
      <label>Hex<input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#2e6b4f" spellCheck={false} disabled={disabled} /></label>
      {band && problems.length === 0 && <p className="field-note">Text on it: {band.fg === "#faf7f1" ? "cream" : "navy"}. In the dark theme: <span className="appearance-chip-swatch" style={{ background: band.bg_night }} aria-hidden="true" /> {band.bg_night} with cream text.</p>}
      {problems.length > 0 && <div className="appearance-problems" role="alert">
        <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        {nearest && <button type="button" className="ghost" onClick={() => setHex(nearest)}>Use the nearest shade that works ({nearest})</button>}
      </div>}
    </div>}
  </fieldset>;
}

/** A look's colours in a strip: header, page, ink and accent. */
function LookSwatch({ look }: { look: Look }) {
  const t = lookTheme(look);
  const ground = t.ground?.ground ?? "#faf7f1", ink = t.ink ?? "#0b2a3d";
  const header = t.header === "tint" ? t.accent.accent_tint : t.header === "ink" ? ink : t.header === "accent" ? t.accent.night_fill
    : t.header === "custom" && t.headerBand ? t.headerBand.bg : ground;
  return <span className="appearance-look-swatch" aria-hidden="true">
    <span style={{ background: header }} /><span style={{ background: ground }} /><span style={{ background: ink }} /><span style={{ background: t.accent.accent }} />
  </span>;
}

/** Ready-made choices for one of the page's colours, and "your own" with a colour picker. */
function PageChoice({ label, value, onChange, disabled, options, custom }: {
  label: string; value: string; onChange: (id: string) => void; disabled: boolean;
  options: { id: string; label: string; swatch: string }[];
  custom: { hex: string; setHex: (h: string) => void; problems: string[]; nearest: string | null; note: string; label?: string };
}) {
  const base = normalizeHex(custom.hex);
  return <fieldset className="appearance-bands">
    <legend>{label}</legend>
    <div role="radiogroup" aria-label={label}>
      {options.map((o) => <button type="button" key={o.id} role="radio" aria-checked={value === o.id} disabled={disabled}
        className="appearance-band" onClick={() => onChange(o.id)}>
        <span className="appearance-page-swatch" style={{ background: o.swatch }} aria-hidden="true" />
        <span><b>{o.label}</b></span>
      </button>)}
      <button type="button" role="radio" aria-checked={value === CUSTOM_CHOICE} disabled={disabled} className="appearance-band" onClick={() => onChange(CUSTOM_CHOICE)}>
        <span className="appearance-page-swatch" style={{ background: base ?? "transparent" }} aria-hidden="true" />
        <span><b>{custom.label ?? "Your own colour"}</b></span>
      </button>
    </div>
    {value === CUSTOM_CHOICE && <div className="appearance-custom appearance-band-colour">
      <label>Colour<input type="color" value={base ?? "#000000"} onChange={(e) => custom.setHex(e.target.value)} disabled={disabled} /></label>
      <label>Hex<input value={custom.hex} onChange={(e) => custom.setHex(e.target.value)} spellCheck={false} disabled={disabled} /></label>
      <p className="field-note">{custom.note}</p>
      {custom.problems.length > 0 && <div className="appearance-problems" role="alert">
        <ul>{custom.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        {custom.nearest && <button type="button" className="ghost" onClick={() => custom.setHex(custom.nearest!)}>Use the nearest shade that works ({custom.nearest})</button>}
      </div>}
    </div>}
  </fieldset>;
}

/** The theme's custom properties as an inline style, so a preview can wear a palette the page is not wearing. */
function themeVarsStyle(theme: CoopTheme): CSSProperties {
  const vars = themeVars(theme);
  // A new, unsaved logo is a blob: URL, which themeVars leaves out on purpose (only the bucket is trusted on the
  // live page). The preview may show it.
  for (const slot of LOGO_SLOTS) {
    const url = theme.logos[slot];
    if (url?.startsWith("blob:")) vars[LOGO_VARS[slot]] = `url("${url}")`;
  }
  return vars as CSSProperties;
}

/** A small, representative screen in one theme: the header, a card with accent text, a button and a band. */
function Preview({ theme, mode }: { theme: CoopTheme; mode: "light" | "dark" }) {
  const darkBand = (b: BandStyle, band: BandTokens | null) => mode === "dark" || b === "ink" || b === "accent" || (b === "custom" && band !== null && bandTone(band) === "dark");
  return <figure className={`appearance-preview theme-preview-${mode}`} style={themeVarsStyle(theme)}>
    <figcaption>{mode === "light" ? "Light" : "Dark"}</figcaption>
    <div className="appearance-preview-shell">
    <div className="appearance-preview-side" data-band={theme.sidebar} data-for="sidebar" aria-hidden="true">
      <span className={`coop-logo mark ${darkBand(theme.sidebar, theme.sidebarBand) ? "on-dark" : "on-light"}`} />
      <span className="appearance-preview-nav on"><span className="appearance-preview-marker" data-marker={theme.whimsy.marker} />Today</span>
      <span className="appearance-preview-nav">Messages</span>
      <span className="appearance-preview-nav">Classes</span>
    </div>
    <div className="appearance-preview-main">
    <div className="appearance-preview-header" data-band={theme.header} data-for="header">
      <span className={`coop-logo lockup ${darkBand(theme.header, theme.headerBand) ? "on-dark" : "on-light"}`} aria-hidden="true" />
      <span className="appearance-preview-rule" aria-hidden="true" />
    </div>
    <div className="appearance-preview-body">
      <p className="appearance-preview-eyebrow">This week</p>
      <h3>Welcome back to <em>{theme.name}</em></h3>
      <p className="appearance-preview-text">Classes start at 9:00. <a href="#preview" onClick={(e) => e.preventDefault()}>See the calendar</a></p>
      <div className="appearance-preview-row">
        <span className="appearance-preview-button">Sign up</span>
        <span className="appearance-preview-chip">New</span>
        <span className="appearance-preview-today" aria-label="Today">14</span>
      </div>
      <div className="appearance-preview-band"><span>Admin</span> <span className="appearance-preview-band-accent">3 waiting</span></div>
    </div>
    </div>
    </div>
  </figure>;
}
