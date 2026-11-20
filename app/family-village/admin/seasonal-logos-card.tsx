"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { LOGO_BUCKET, LOGO_SLOTS, LOGO_TYPES, activeVariant, coopToday, type LogoSlot, type LogoVariant } from "../../../lib/coop-theme";
import { LOGO_VARIANT_COLUMNS, brandFileUrl, coopTheme, fetchCoopTheme, setCoopTheme } from "../../../lib/coop-settings";
import { logoProblem } from "../../../lib/logo-files";

/**
 * Admin, Appearance: seasonal logos (issue #140 part 3, #110). Variants of the logo with a date range (optionally every
 * year) and an override. The one in force replaces the co-op's logo in the header, on sign-in and in the browser tab;
 * any slot it leaves empty keeps the co-op's own. Saved on its own, apart from the rest of the page.
 */

type Row = {
  id: string; name: string; starts_on: string; ends_on: string; yearly: boolean; override: "auto" | "on" | "off";
  logo_light_path: string | null; logo_dark_path: string | null; mark_light_path: string | null; mark_dark_path: string | null;
  logo_ratio: number | null; updated_at: string;
};
type FileDraft = { kind: "keep" } | { kind: "new"; file: File; url: string; ratio: number } | { kind: "clear" };
type Draft = { id: string | null; name: string; startsOn: string; endsOn: string; yearly: boolean; override: Row["override"]; files: Record<LogoSlot, FileDraft> };

const SLOT_NAMES: Record<LogoSlot, string> = {
  logo_light: "Logo, light backgrounds", logo_dark: "Logo, dark backgrounds",
  mark_light: "Compact mark, light (also the browser tab icon)", mark_dark: "Compact mark, dark",
};
const keepAll = (): Record<LogoSlot, FileDraft> => ({ logo_light: { kind: "keep" }, logo_dark: { kind: "keep" }, mark_light: { kind: "keep" }, mark_dark: { kind: "keep" } });

function asVariant(r: Row): LogoVariant {
  const logos: Partial<Record<LogoSlot, string>> = {};
  for (const slot of LOGO_SLOTS) if (r[`${slot}_path`]) logos[slot] = "x";
  return { name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, yearly: r.yearly, override: r.override, logos, ratio: r.logo_ratio, updatedAt: r.updated_at };
}

function when(r: Row): string {
  const fmt = (iso: string, year: boolean) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return r.yearly ? `${fmt(r.starts_on, false)} to ${fmt(r.ends_on, false)}, every year` : `${fmt(r.starts_on, true)} to ${fmt(r.ends_on, true)}`;
}

export default function SeasonalLogosCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<LogoSlot, string>>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("coop_logo_variants").select(LOGO_VARIANT_COLUMNS).order("starts_on");
    if (error) { setStatus(error.message); return; }
    setRows((data ?? []) as unknown as Row[]);
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, []);

  async function refreshLive() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const theme = await fetchCoopTheme(supabase);
    if (theme) setCoopTheme(theme);
  }

  function startNew() {
    setErrors({});
    setDraft({ id: null, name: "", startsOn: "", endsOn: "", yearly: true, override: "auto", files: keepAll() });
  }
  function startEdit(r: Row) {
    setErrors({});
    setDraft({ id: r.id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on, yearly: r.yearly, override: r.override, files: keepAll() });
  }

  async function pick(slot: LogoSlot, file: File | undefined) {
    if (!file || !draft) return;
    const result = await logoProblem(slot, file).catch((e: Error) => e.message);
    if (typeof result === "string") { setErrors((e) => ({ ...e, [slot]: result })); return; }
    if (result === null) return;
    setErrors((e) => ({ ...e, [slot]: undefined }));
    setDraft((d) => d && ({ ...d, files: { ...d.files, [slot]: { kind: "new", file, url: URL.createObjectURL(file), ratio: result.ratio } } }));
  }

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !draft) return;
    const existing = rows?.find((r) => r.id === draft.id);
    setBusy(true);
    setStatus("Saving…");
    try {
      const paths: Record<LogoSlot, string | null> = { logo_light: null, logo_dark: null, mark_light: null, mark_dark: null };
      const replaced: string[] = [];
      let ratio: number | null = existing?.logo_ratio ?? null;
      for (const slot of LOGO_SLOTS) {
        const f = draft.files[slot];
        const old = existing?.[`${slot}_path`] ?? null;
        if (f.kind === "keep") { paths[slot] = old; continue; }
        if (old) replaced.push(old);
        if (f.kind === "clear") continue;
        const ext = f.file.type === "image/png" ? "png" : f.file.type === "image/webp" ? "webp" : "jpg";
        const path = `seasonal/${crypto.randomUUID().replaceAll("-", "")}.${ext}`;
        const { error } = await supabase.storage.from(LOGO_BUCKET).upload(path, f.file, { contentType: f.file.type, cacheControl: "31536000", upsert: false });
        if (error) throw new Error(`${SLOT_NAMES[slot]} could not be uploaded: ${error.message}`);
        paths[slot] = path;
        if (slot === "logo_light") ratio = f.ratio;
      }
      const { error } = await supabase.rpc("admin_save_logo_variant", {
        p_id: draft.id, p_name: draft.name, p_starts_on: draft.startsOn || null, p_ends_on: draft.endsOn || null,
        p_yearly: draft.yearly, p_override: draft.override,
        p_logo_light_path: paths.logo_light, p_logo_dark_path: paths.logo_dark, p_mark_light_path: paths.mark_light, p_mark_dark_path: paths.mark_dark,
        p_logo_ratio: paths.logo_light ? ratio : null,
      });
      if (error) throw new Error(error.message);
      if (replaced.length) await supabase.storage.from(LOGO_BUCKET).remove(replaced).catch(() => {});
      setDraft(null);
      await load();
      await refreshLive();
      setStatus("Saved.");
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setConfirmRemove(null);
    setBusy(true);
    const { data, error } = await supabase.rpc("admin_delete_logo_variant", { p_id: id });
    if (error) setStatus(error.message);
    else {
      const files = (data ?? []) as string[];
      if (files.length) await supabase.storage.from(LOGO_BUCKET).remove(files).catch(() => {});
      setStatus("Removed.");
      await load();
      await refreshLive();
    }
    setBusy(false);
  }

  const supabase = getSupabaseBrowserClient();
  const today = coopToday(coopTheme().timeZone);
  const showing = rows ? activeVariant(rows.map(asVariant), today) : null;
  const showingRow = showing && rows ? rows.find((r) => r.name === showing.name && r.updated_at === showing.updatedAt) : null;
  const statusOf = (r: Row) => r === showingRow ? "Showing now" : r.override === "off" ? "Off" : r.override === "on" ? "On (another one wins)" : "Scheduled";

  return <section className="appearance-card">
    <p className="card-kicker">Seasonal logos</p>
    <p className="field-note">Versions of the logo for seasons and holidays. The one in force takes the place of the co-op&rsquo;s logo in the header, on sign-in and in the browser tab; anything it leaves out keeps the co-op&rsquo;s own. Home-screen and app icons do not change.</p>
    {rows === null ? <p className="field-note">Loading…</p> : rows.length === 0 && !draft ? <p className="field-note">None yet.</p> : null}
    {rows && rows.length > 0 && <ul className="seasonal-list">
      {rows.map((r) => <li key={r.id}>
        <div className="seasonal-thumbs" aria-hidden="true">
          {LOGO_SLOTS.filter((s) => r[`${s}_path`]).map((s) => <span key={s} className={`seasonal-thumb ${s.endsWith("dark") ? "on-dark" : "on-light"}`}
            style={{ backgroundImage: supabase ? `url("${brandFileUrl(supabase, r[`${s}_path`] as string)}")` : undefined }} />)}
        </div>
        <div className="seasonal-text">
          <p className="appearance-logo-title">{r.name} <span className={`seasonal-status${r === showingRow ? " live" : ""}`}>{statusOf(r)}</span></p>
          <p className="field-note">{r.override === "on" ? "Shown now, whatever the date" : r.override === "off" ? "Turned off" : when(r)}</p>
        </div>
        <div className="seasonal-actions">
          <button type="button" className="ghost" disabled={busy} onClick={() => startEdit(r)}>Edit</button>
          {confirmRemove === r.id
            ? <><button type="button" className="ghost" disabled={busy} onClick={() => void remove(r.id)}>Remove</button><button type="button" className="ghost" onClick={() => setConfirmRemove(null)}>Keep</button></>
            : <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmRemove(r.id)}>Remove…</button>}
        </div>
      </li>)}
    </ul>}

    {!draft && <div><button type="button" className="ghost" disabled={busy} onClick={startNew}>Add a seasonal logo</button></div>}

    {draft && <div className="seasonal-form">
      <label>Name<input value={draft.name} maxLength={60} placeholder="Harvest" onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} /></label>
      <div className="seasonal-dates">
        <label>Starts<input type="date" value={draft.startsOn} onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} disabled={busy} /></label>
        <label>Ends<input type="date" value={draft.endsOn} onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} disabled={busy} /></label>
      </div>
      <label className="seasonal-check"><input type="checkbox" checked={draft.yearly} onChange={(e) => setDraft({ ...draft, yearly: e.target.checked })} disabled={busy} /> Every year on these days</label>
      <label>When it shows
        <select value={draft.override} onChange={(e) => setDraft({ ...draft, override: e.target.value as Row["override"] })} disabled={busy}>
          <option value="auto">Between these dates</option>
          <option value="on">Now, whatever the date</option>
          <option value="off">Not at all (keep it for later)</option>
        </select>
      </label>
      {LOGO_SLOTS.map((slot) => {
        const f = draft.files[slot];
        const existing = rows?.find((r) => r.id === draft.id)?.[`${slot}_path`] ?? null;
        const url = f.kind === "new" ? f.url : f.kind === "keep" && existing && supabase ? brandFileUrl(supabase, existing) : null;
        return <div className="appearance-logo-slot" key={slot}>
          <div className={`appearance-logo-thumb ${slot.endsWith("dark") ? "on-dark" : "on-light"}`}>
            {url ? <span className={`coop-logo ${slot.startsWith("logo") ? "lockup" : "mark"}`} style={{ backgroundImage: `url("${url}")` }} aria-hidden="true" /> : <small className="seasonal-empty">Co-op logo</small>}
          </div>
          <div>
            <p className="appearance-logo-title">{SLOT_NAMES[slot]}</p>
            <label className="appearance-upload">{url ? "Replace" : "Upload"}
              <input type="file" accept={LOGO_TYPES.join(",")} disabled={busy} onChange={(e) => { void pick(slot, e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            {url && <button type="button" className="ghost" disabled={busy} onClick={() => setDraft({ ...draft, files: { ...draft.files, [slot]: { kind: "clear" } } })}>Use the co-op logo here</button>}
            {errors[slot] && <p className="appearance-problem" role="alert">{errors[slot]}</p>}
          </div>
        </div>;
      })}
      <div className="appearance-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => void save()}>{draft.id ? "Save seasonal logo" : "Add seasonal logo"}</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </div>}
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </section>;
}
