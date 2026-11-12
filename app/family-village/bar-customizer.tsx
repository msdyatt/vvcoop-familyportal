"use client";

import { useState } from "react";
import {
  availableDestinations, DEFAULT_BARS, MAX_SLOTS, resolveBar, SECTION_LABELS,
  type NavPrefs, type Section,
} from "../../lib/nav-prefs";

/**
 * Edits the bottom bar: the main one (Family and Teaching items together) and, for admins, the Admin bar,
 * which stays separate. Changes are held here until Save.
 */
export default function BarCustomizer({ roles, prefs, startSection, single = false, onSave, onClose }: {
  roles: string[];
  prefs: NavPrefs;
  startSection: Section;
  /** The iPhone app has one bar for everything: edit only the main one (and offer Admin pages on it). */
  single?: boolean;
  onSave: (next: NavPrefs) => Promise<string>;
  onClose: () => void;
}) {
  const sections: Section[] = single || !roles.includes("admin") ? ["home"] : ["home", "admin"];
  const [section, setSection] = useState<Section>(sections.includes(startSection) ? startSection : "home");
  const [draft, setDraft] = useState<NavPrefs>(() => Object.fromEntries(sections.map((s) => [s, resolveBar(prefs, s, roles).map((d) => d.id)])) as NavPrefs);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const ids = draft[section] ?? [];
  const pool = availableDestinations(roles);
  const label = (id: string) => pool.find((d) => d.id === id)?.label ?? id;
  const full = ids.length >= MAX_SLOTS;
  const set = (next: string[]) => setDraft({ ...draft, [section]: next });

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    [next[index], next[to]] = [next[to], next[index]];
    set(next);
  }

  async function save() {
    if (!ids.length) { setStatus("Keep at least one item on the bar."); return; }
    setSaving(true);
    const problem = await onSave(draft);
    setSaving(false);
    if (problem) { setStatus(problem); return; }
    onClose();
  }

  // Family and Teaching are one list; Admin is set apart, and labelled only when both are on offer.
  const areas = Array.from(new Set(pool.map((d) => d.area)));

  return <div className="bar-customizer">
    <p className="field-note">Choose up to {MAX_SLOTS} shortcuts for the bar at the bottom of the screen. Menu always stays at the end. {sections.length > 1 ? "Admin pages have their own bar, so they are never one tap from the main one by accident." : "The same bar shows on every page."}</p>

    {sections.length > 1 && <div className="bar-sections" role="tablist" aria-label="Section">
      {sections.map((s) => <button key={s} type="button" role="tab" aria-selected={s === section} className={s === section ? "active" : ""} onClick={() => { setSection(s); setStatus(""); }}>{SECTION_LABELS[s]}</button>)}
    </div>}

    <h3>{sections.length > 1 ? `On the ${SECTION_LABELS[section].toLowerCase()}` : "On your bar"}</h3>
    <ol className="bar-chosen">
      {ids.map((id, index) => <li key={id}>
        <span>{label(id)}</span>
        <span className="bar-chosen-actions">
          <button type="button" className="bar-icon-btn" aria-label={`Move ${label(id)} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="bar-icon-btn" aria-label={`Move ${label(id)} later`} disabled={index === ids.length - 1} onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="bar-icon-btn" aria-label={`Remove ${label(id)}`} onClick={() => set(ids.filter((x) => x !== id))}>×</button>
        </span>
      </li>)}
      {!ids.length && <li className="bar-empty">Nothing yet. Add something below.</li>}
    </ol>

    <h3>Add to the bar</h3>
    {full && <p className="field-note">The bar is full. Remove one to add another.</p>}
    {areas.map((area) => {
      const choices = pool.filter((d) => d.area === area && !ids.includes(d.id));
      if (!choices.length) return null;
      return <div key={area} className="bar-group">
        {areas.length > 1 && <p className="card-kicker">{area === "admin" ? "Admin" : "Family and teaching"}</p>}
        <div className="bar-choices">
          {choices.map((d) => <button key={d.id} type="button" className="ghost bar-choice" disabled={full} onClick={() => set([...ids, d.id])}>+ {d.label}</button>)}
        </div>
      </div>;
    })}

    {status && <p className="admin-form-status" role="status">{status}</p>}
    <div className="bar-footer">
      <button type="button" className="ghost" onClick={() => { set([...DEFAULT_BARS[section]].filter((id) => pool.some((d) => d.id === id))); setStatus(""); }}>Reset this bar</button>
      <button type="button" className="ghost" onClick={onClose}>Cancel</button>
      <button type="button" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
    </div>
  </div>;
}
