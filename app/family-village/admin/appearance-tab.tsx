"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  CUSTOM_PALETTE_ID, DEFAULT_THEME, HEADING_FONTS, LOGO_BUCKET, LOGO_MAX_BYTES, LOGO_SLOTS, LOGO_TYPES, LOGO_VARS, PALETTES,
  checkAccent, generateAccent, isHeadingFont, nearestUsableAccent, normalizeHex, paletteById, themeVars,
  type AccentTokens, type CoopTheme, type HeadingFontId, type LogoSlot,
} from "../../../lib/coop-theme";
import { COOP_SETTINGS_COLUMNS, brandFileUrl, fetchCoopTheme, setCoopTheme } from "../../../lib/coop-settings";

/**
 * Admin, Appearance: the co-op's name, support contact, accent palette, heading font and logos (issue #140,
 * docs/theming.md "Co-op theme"). Everything is a draft until Save: the preview shows it in the light and the dark
 * theme side by side, and a palette that fails a contrast check cannot be saved (the database checks again).
 */

type Row = {
  name: string; palette_id: string; accent: AccentTokens; heading_font: string;
  logo_light_path: string | null; logo_dark_path: string | null; mark_light_path: string | null; mark_dark_path: string | null;
  logo_ratio: number | null; support_email: string | null; support_phone: string | null;
};

/** A logo slot's draft: unchanged, a new file (with its preview URL and shape), or cleared back to the bundled logo. */
type LogoDraft = { kind: "keep" } | { kind: "new"; file: File; url: string; ratio: number } | { kind: "clear" };

const SLOT_LABELS: Record<LogoSlot, { title: string; hint: string }> = {
  logo_light: { title: "Logo for light backgrounds", hint: "The full logo with the name, in a dark ink. Shown in the header, on sign-in and in emails." },
  logo_dark: { title: "Logo for dark backgrounds", hint: "The same logo in a light ink, for the dark theme and the Admin band." },
  mark_light: { title: "Compact mark, light backgrounds", hint: "A small square version without the name." },
  mark_dark: { title: "Compact mark, dark backgrounds", hint: "The square mark in a light ink." },
};

function readImageShape(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { reject(new Error("That file could not be read as an image.")); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/** Why a file cannot be a logo for this slot, or null. */
async function logoProblem(slot: LogoSlot, file: File): Promise<string | null | { ratio: number }> {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return "Use a PNG, JPEG or WebP file. PNG with a transparent background works best.";
  if (file.size > LOGO_MAX_BYTES) return `That file is ${(file.size / 1048576).toFixed(1)} MB. Logos can be up to 1 MB.`;
  const { width, height } = await readImageShape(file);
  const ratio = width / height;
  if (slot.startsWith("logo")) {
    if (ratio < 1 || ratio > 6) return "A logo here should be wider than it is tall (up to six times as wide). Use the compact mark slots for a square mark.";
    if (width < 300) return `That image is ${width} pixels wide. Use one at least 300 pixels wide so it stays sharp.`;
  } else {
    if (ratio < 0.75 || ratio > 1.33) return "A compact mark should be about square.";
    if (width < 96) return `That image is ${width} pixels wide. Use one at least 96 pixels wide.`;
  }
  return { ratio };
}

export default function AppearanceTab() {
  const [row, setRow] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [supportPhone, setSupportPhone] = useState("");
  const [paletteId, setPaletteId] = useState("veritas");
  const [customHex, setCustomHex] = useState("#bb6141");
  const [font, setFont] = useState<HeadingFontId>("playfair");
  const [logos, setLogos] = useState<Record<LogoSlot, LogoDraft>>({ logo_light: { kind: "keep" }, logo_dark: { kind: "keep" }, mark_light: { kind: "keep" }, mark_dark: { kind: "keep" } });
  const [logoErrors, setLogoErrors] = useState<Partial<Record<LogoSlot, string>>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

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
    setLogos({ logo_light: { kind: "keep" }, logo_dark: { kind: "keep" }, mark_light: { kind: "keep" }, mark_dark: { kind: "keep" } });
    setLogoErrors({});
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
    return { ...DEFAULT_THEME, name: name.trim() || row.name, paletteId, accent, font, logos: current, ratio };
  }, [row, accent, logos, name, paletteId, font]);

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
    setStatus("Back to the Veritas Village palette, Playfair Display and the bundled logos. The name and contact are unchanged.");
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
        <p className="card-kicker">Heading font</p>
        <div className="appearance-fonts" role="radiogroup" aria-label="Heading font">
          {HEADING_FONTS.map((f) => <button type="button" key={f.id} role="radio" aria-checked={font === f.id} disabled={busy}
            className="appearance-font" onClick={() => setFont(f.id)}>
            <span className="appearance-font-sample" style={{ fontFamily: f.stack }}>{name.trim() || row.name}</span>
            <small>{f.label}: {f.hint}</small>
          </button>)}
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
          : <span className="appearance-confirm">Go back to the Veritas palette, font and logos?
            <button type="button" className="ghost" onClick={reset}>Reset</button>
            <button type="button" className="ghost" onClick={() => setConfirmReset(false)}>Keep</button></span>}
      </div>
      <p className="admin-form-status" role="status">{status || "Nothing changes for anyone until you save."}</p>
    </aside>
  </section>;
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
  return <figure className={`appearance-preview theme-preview-${mode}`} style={themeVarsStyle(theme)}>
    <figcaption>{mode === "light" ? "Light" : "Dark"}</figcaption>
    <div className="appearance-preview-header">
      <span className={`coop-logo lockup ${mode === "light" ? "on-light" : "on-dark"}`} aria-hidden="true" />
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
  </figure>;
}
