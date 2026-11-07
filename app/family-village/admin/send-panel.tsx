"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { friendlyError } from "../../../lib/sign";
import type { Template } from "./field-editor";

type Adult = { user_id: string; name: string; active: boolean };
type FamilyChoice = { id: string; name: string; adults: Adult[] };

const REASONS: Record<string, string> = {
  no_adult: "has no active adult",
  already_sent: "already has this document",
  already_complete: "already complete",
  already_waived: "was waived",
  unknown_household: "no longer exists",
};

/**
 * Sends a document to households. If the document is marked required for this
 * school year (on the Documents list), sending is tracked in Compliance
 * automatically, and it can go to every household that still owes it. Otherwise
 * it goes to households picked by hand. Who signs in which slot is decided by
 * the order adults joined the household, and can be changed here.
 */
export default function SendPanel({ template, requirementId, yearLabel, onClose, onSent }: {
  template: Template; requirementId: string | null; yearLabel: string; onClose: () => void;
  /** Called after a successful send, with a one-line summary; the list shows it. */
  onSent: (summary: string) => void;
}) {
  const [mode, setMode] = useState<"requirement" | "families">(requirementId ? "requirement" : "families");
  const [families, setFamilies] = useState<FamilyChoice[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [assignments, setAssignments] = useState<Record<string, string[]>>({});
  const [sequential, setSequential] = useState(false);
  const [note, setNote] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: number; skipped: { name: string; reason: string }[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("families").select("id,display_name,family_members(user_id,profiles(display_name,email,status))").order("display_name");
      if (cancelled) return;
      setFamilies(((data ?? []) as unknown as { id: string; display_name: string; family_members: { user_id: string; profiles: { display_name: string | null; email: string; status: string } | null }[] }[]).map((f) => ({
        id: f.id, name: f.display_name,
        adults: f.family_members.map((m) => ({ user_id: m.user_id, name: m.profiles?.display_name || m.profiles?.email || "Adult", active: m.profiles?.status === "active" })),
      })));
    })();
    return () => { cancelled = true; };
  }, [template.id]);

  const visible = useMemo(() => families.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())), [families, filter]);
  const nameOf = (id: string) => families.find((f) => f.id === id)?.name ?? "A household";

  async function send() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setError(""); setResult(null);
    const args: Record<string, unknown> = {
      p_template: template.id, p_sequential: sequential, p_message: note.trim() || null, p_due_on: dueOn || null,
    };
    // A required document is always tracked against this year's requirement.
    args.p_requirement = requirementId;
    if (mode !== "requirement") {
      args.p_family_ids = [...chosen];
      const override: Record<string, string[]> = {};
      for (const id of chosen) if (assignments[id]?.length === template.signers_required) override[id] = assignments[id];
      args.p_assignments = override;
    }
    const { data, error: rpcError } = await supabase.rpc("sign_send", args);
    setBusy(false);
    if (rpcError) { setError(friendlyError(rpcError)); return; }
    const r = data as { sent: unknown[]; skipped: { family_id: string; reason: string }[] };
    const skipped = r.skipped.map((x) => ({ name: nameOf(x.family_id), reason: REASONS[x.reason] ?? x.reason }));
    if (r.sent.length) {
      const sentText = `Sent “${template.title}” to ${r.sent.length} ${r.sent.length === 1 ? "household" : "households"}.`;
      onSent(skipped.length ? `${sentText} Not sent: ${skipped.map((x) => `${x.name} ${x.reason}`).join("; ")}.` : sentText);
      return;
    }
    // Nothing went out, so stay here and say why.
    setResult({ sent: 0, skipped });
  }

  const ready = mode === "requirement" ? !!requirementId : chosen.size > 0;

  return <section className="send-panel" aria-label={`Send ${template.title}`}>
    <div className="field-editor-bar">
      <button type="button" className="sign-big secondary compact" onClick={onClose}>← Back to documents</button>
      <h2>Send “{template.title}”</h2>
    </div>
    <p className="sign-hint">{requirementId ? `Tracked in Compliance for ${yearLabel}.` : "Not marked required, so this is not tracked in Compliance."}</p>

    <div className="send-panel-grid">
      <fieldset>
        <legend>Who gets it</legend>
        {requirementId && <label className="checkbox-field"><input type="radio" name="mode" checked={mode === "requirement"} onChange={() => setMode("requirement")} /> Every household that has not signed it yet for {yearLabel}</label>}
        {requirementId && <label className="checkbox-field"><input type="radio" name="mode" checked={mode === "families"} onChange={() => setMode("families")} /> Households I pick</label>}
        {mode === "families" && <>
          <input type="search" placeholder="Filter households" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter households" />
          <ul className="send-families">
            {visible.map((f) => <li key={f.id}>
              <label className="checkbox-field"><input type="checkbox" checked={chosen.has(f.id)}
                onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} />
                {f.name} <span className="sign-hint">({f.adults.filter((a) => a.active).length} active {f.adults.filter((a) => a.active).length === 1 ? "adult" : "adults"})</span></label>
              {chosen.has(f.id) && f.adults.filter((a) => a.active).length > template.signers_required && <div className="send-assign">
                {Array.from({ length: template.signers_required }, (_, i) => <label key={i}><span className="field-caption">Signer {i + 1}</span>
                  <select value={assignments[f.id]?.[i] ?? ""} onChange={(e) => setAssignments((a) => {
                    const row = [...(a[f.id] ?? [])]; row[i] = e.target.value; return { ...a, [f.id]: row };
                  })}>
                    <option value="">Default</option>
                    {f.adults.filter((a) => a.active).map((a) => <option key={a.user_id} value={a.user_id}>{a.name}</option>)}
                  </select></label>)}
              </div>}
            </li>)}
          </ul>
        </>}
      </fieldset>

      <fieldset>
        <legend>Details</legend>
        {template.signers_required === 2 && <>
          <label className="checkbox-field"><input type="radio" name="order" checked={!sequential} onChange={() => setSequential(false)} /> Either can sign first</label>
          <label className="checkbox-field"><input type="radio" name="order" checked={sequential} onChange={() => setSequential(true)} /> Signer 1 signs first, then signer 2</label>
        </>}
        <label><span className="field-caption">Note to the signers <i>optional</i></span>
          <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Please sign before the first day of class." /></label>
        <label><span className="field-caption">Ask them to sign by <i>optional</i></span>
          <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
        <button type="button" className="sign-big" disabled={!ready || busy} onClick={send}>{busy ? "Sending…" : "Send for signature"}</button>
      </fieldset>
    </div>

    {error && <p className="admin-form-status" role="alert">{error}</p>}
    {result && <div className="admin-form-status" role="status">
      <p>Nothing was sent.</p>
      {result.skipped.length > 0 && <ul>{result.skipped.map((s, i) => <li key={i}>{s.name} {s.reason}.</li>)}</ul>}
    </div>}
  </section>;
}
