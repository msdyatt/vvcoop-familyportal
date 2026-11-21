"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { clock } from "../../../lib/report-doc";
import type { CommitmentData, CommitmentSettings } from "../../../lib/teaching-commitment";

/** Who is hall monitor in each period of a term (public.hall_monitor_assignments). Counted in the tracker. */
export function HallMonitorsCard({ data, onChanged }: { data: CommitmentData; onChanged: () => Promise<unknown> }) {
  const terms = data.terms ?? [];
  const periods = data.periods ?? [];
  const [open, setOpen] = useState(false);
  const [termId, setTermId] = useState(terms.find((term) => term.starts_on <= (data.today ?? "") && term.ends_on >= (data.today ?? ""))?.id ?? terms[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const people = new Map((data.candidates ?? []).map((candidate) => [candidate.user_id, candidate]));
  const active = (data.candidates ?? []).filter((candidate) => candidate.status === "active");

  async function change(blockId: string, userId: string, on: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !userId) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_set_hall_monitor", { p_term_id: termId, p_block_id: blockId, p_user_id: userId, p_on: on });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    await onChanged();
  }

  return <div className={`record${open ? " open" : ""}`}>
    <button type="button" className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary">Hall monitors</span>
      <span className="record-meta">{(data.hall_monitors ?? []).length} assigned this year</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">The hall monitor checks that children are in their classes and greets visitors. Each period counts as one role in the tracker, and as assisting if the settings say so.</p>
      {!periods.length && <p className="portal-empty">This school year has no class periods yet. Add them under Classes.</p>}
      {periods.length > 0 && <>
        <div className="tc-controls">
          <label><span className="field-caption">Term</span>
            <select value={termId} onChange={(event) => setTermId(event.target.value)}>
              {terms.map((term) => <option key={term.id} value={term.id}>{term.label}</option>)}
            </select>
          </label>
        </div>
        <ul className="tc-hall-list">
          {periods.map((period) => {
            const here = (data.hall_monitors ?? []).filter((row) => row.term_id === termId && row.block_id === period.id);
            return <li key={period.id}>
              <b>{period.label}</b> <small>{clock(period.starts_at)} – {clock(period.ends_at)}</small>
              <div className="tc-hall-people">
                {here.map((row) => <span key={row.user_id} className="tc-chip">
                  {people.get(row.user_id)?.name ?? "A member"}
                  <button type="button" className="tc-chip-x" disabled={busy} aria-label={`Take ${people.get(row.user_id)?.name ?? "this member"} off ${period.label}`}
                    onClick={() => void change(period.id, row.user_id, false)}>×</button>
                </span>)}
                <select aria-label={`Add a hall monitor for ${period.label}`} value="" disabled={busy || !termId}
                  onChange={(event) => void change(period.id, event.target.value, true)}>
                  <option value="">Add a hall monitor…</option>
                  {active.filter((candidate) => !here.some((row) => row.user_id === candidate.user_id)).map((candidate) =>
                    <option key={candidate.user_id} value={candidate.user_id}>{candidate.name}{candidate.household_name ? ` (${candidate.household_name})` : ""}</option>)}
                </select>
              </div>
            </li>;
          })}
        </ul>
      </>}
      {message && <p className="admin-form-status" role="status">{message}</p>}
    </div>}
  </div>;
}

/** The handbook's expectation and the "carrying a lot" mark (public.teaching_commitment_settings). */
export function CommitmentSettingsCard({ settings, onSaved }: { settings: CommitmentSettings; onSaved: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [teach, setTeach] = useState(String(settings.teach_target));
  const [assist, setAssist] = useState(String(settings.assist_target));
  const [hall, setHall] = useState(settings.hall_counts_as_assist);
  const [heavy, setHeavy] = useState(String(settings.heavy_load));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_save_commitment_settings", {
      p_teach_target: Number(teach), p_assist_target: Number(assist), p_hall_counts_as_assist: hall, p_heavy_load: Number(heavy),
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Saved.");
    await onSaved();
  }

  return <div className={`record${open ? " open" : ""}`}>
    <button type="button" className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary">Expectation and settings</span>
      <span className="record-meta">Teach {settings.teach_target}, assist {settings.assist_target} each co-op day</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">The handbook asks each family for one adult to teach one class and assist in at least two each co-op day. A household is checked for each term once the term has started or anyone has a role in it.</p>
      <div className="portal-form tc-settings">
        <label><span className="field-caption">Classes to teach per household, each co-op day</span>
          <input type="number" min={0} max={8} step={1} value={teach} onChange={(event) => setTeach(event.target.value)} />
        </label>
        <label><span className="field-caption">Periods to assist per household, each co-op day</span>
          <input type="number" min={0} max={8} step={1} value={assist} onChange={(event) => setAssist(event.target.value)} />
        </label>
        <label className="checkbox-field"><input type="checkbox" checked={hall} onChange={(event) => setHall(event.target.checked)} /> A period as hall monitor counts as assisting</label>
        <label><span className="field-caption">Mark an adult as carrying a lot at this many roles in one term</span>
          <input type="number" min={1} max={12} step={1} value={heavy} onChange={(event) => setHeavy(event.target.value)} />
        </label>
        <div className="row-actions"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save settings"}</button></div>
        {message && <p className="admin-form-status" role="status">{message}</p>}
      </div>
    </div>}
  </div>;
}
