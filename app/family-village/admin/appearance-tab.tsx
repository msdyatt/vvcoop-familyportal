"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  BAND_STYLES, BODY_FONTS, CUSTOM_PALETTE_ID, DEFAULT_THEME, DEFAULT_WHIMSY, HEADING_FONTS, LOGO_BUCKET, LOGO_SLOTS, LOGO_TYPES, LOGO_VARS, PALETTES,
  WHIMSY_MARKERS, checkAccent, generateAccent, isBandStyle, isBodyFont, isHeadingFont, nearestUsableAccent, normalizeHex, paletteById, parseWhimsy, themeVars,
  type AccentTokens, type BandStyle, type BodyFontId, type CoopTheme, type HeadingFontId, type LogoSlot, type Whimsy, type WhimsyMarker, type WhimsySeason,
} from "../../../lib/coop-theme";
import { COOP_SETTINGS_COLUMNS, brandFileUrl, fetchCoopTheme, setCoopTheme } from "../../../lib/coop-settings";
import { logoProblem } from "../../../lib/logo-files";
import SeasonalLogosCard from "./seasonal-logos-card";

/**
 * Admin, Appearance: the co-op's name, support contact, accent palette, fonts, header and sidebar, small touches and logos (issue #140,
 * docs/theming.md "Co-op theme"). Everything is a draft until Save: the preview shows it in the light and the dark
 * theme side by side, and a palette that fails a contrast check cannot be saved (the database checks again).
 */

type Row = {
  name: string; palette_id: string; accent: AccentTokens; heading_font: string;
  body_font: string | null; header_style: string | null; sidebar_style: string | null; whimsy: unknown;
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
    return { ...DEFAULT_THEME, name: name.trim() || row.name, paletteId, accent, font, bodyFont, header, sidebar, whimsy, logos: current, ratio };
  }, [row, accent, logos, name, paletteId, font, bodyFont, header, sidebar, whimsy]);

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
      });
      if (styleError) throw new Error(styleError.message);
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
        <p className="card-kicker">Header and sidebar</p>
        <p className="field-note">Each style only uses colour pairs that are already checked for contrast, so the text stays easy to read in Light and Dark. Admin keeps its navy band.</p>
        <BandPicker label="Header" value={header} onChange={setHeader} disabled={busy} swatchStyle={draft ? themeVarsStyle(draft) : undefined} />
        <BandPicker label="Sidebar" value={sidebar} onChange={setSidebar} disabled={busy} swatchStyle={draft ? themeVarsStyle(draft) : undefined} />
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
        <button type="button" onClick={save} disabled={busy || !accent || problems.length > 0}>{busy ? "Working…" : "Save appearance"}</button>
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

/** The four band styles as small swatches, for the header or the sidebar. */
function BandPicker({ label, value, onChange, disabled, swatchStyle }: { label: string; value: BandStyle; onChange: (b: BandStyle) => void; disabled: boolean; swatchStyle?: CSSProperties }) {
  return <fieldset className="appearance-bands">
    <legend>{label}</legend>
    <div role="radiogroup" aria-label={`${label} style`}>
      {BAND_STYLES.map((b) => <button type="button" key={b.id} role="radio" aria-checked={value === b.id} disabled={disabled}
        className="appearance-band" onClick={() => onChange(b.id)}>
        {/* The swatch wears the draft palette in the light roles, so it shows what Save would give. */}
        <span className="appearance-band-swatch theme-preview-light" data-band={b.id} style={swatchStyle} aria-hidden="true"><span>Aa</span></span>
        <span><b>{b.label}</b><small>{b.hint}</small></span>
      </button>)}
    </div>
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
  const darkBand = (b: BandStyle) => mode === "dark" || b === "ink" || b === "accent";
  return <figure className={`appearance-preview theme-preview-${mode}`} style={themeVarsStyle(theme)}>
    <figcaption>{mode === "light" ? "Light" : "Dark"}</figcaption>
    <div className="appearance-preview-shell">
    <div className="appearance-preview-side" data-band={theme.sidebar} aria-hidden="true">
      <span className={`coop-logo mark ${darkBand(theme.sidebar) ? "on-dark" : "on-light"}`} />
      <span className="appearance-preview-nav on"><span className="appearance-preview-marker" data-marker={theme.whimsy.marker} />Today</span>
      <span className="appearance-preview-nav">Messages</span>
      <span className="appearance-preview-nav">Classes</span>
    </div>
    <div className="appearance-preview-main">
    <div className="appearance-preview-header" data-band={theme.header}>
      <span className={`coop-logo lockup ${darkBand(theme.header) ? "on-dark" : "on-light"}`} aria-hidden="true" />
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
