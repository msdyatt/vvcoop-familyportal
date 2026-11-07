"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { friendlyError } from "../../../lib/sign";
import type { Template } from "./field-editor";

type Adult = { user_id: string; name: string; active: boolean };
type FamilyChoice = { id: string; name: string; adults: Adult[] };
type RequirementChoice = { id: string; title: string; outstanding: number; sign_template_id: string | null };

const REASONS: Record<string, string> = {
  no_adult: "has no active adult",
  already_sent: "already has this document",
  already_complete: "already complete",
  already_waived: "was waived",
  unknown_household: "no longer exists",
};

/**
 * Sends a document to households: either every household that still owes a
 * required document, or households picked by hand. Who signs in which slot is
 * decided by the order adults joined the household, and can be changed here.
 */
export default function SendPanel({ template, onClose, onSent }: { template: Template; onClose: () => void; onSent: () => void }) {
  const [mode, setMode] = useState<"requirement" | "families">("requirement");
  const [requirements, setRequirements] = useState<RequirementChoice[]>([]);
  const [requirementId, setRequirementId] = useState("");
  // When households are picked by hand, the document can still be tied to a
  // required document so each household&rsquo;s Paperwork status follows the signing.
  const [trackId, setTrackId] = useState("");
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
      const [year, fams] = await Promise.all([
        supabase.from("school_years").select("id").eq("is_current", true).maybeSingle(),
        supabase.from("families").select("id,display_name,family_members(user_id,profiles(display_name,email,status))").order("display_name"),
      ]);
      if (cancelled) return;
      setFamilies(((fams.data ?? []) as unknown as { id: string; display_name: string; family_members: { user_id: string; profiles: { display_name: string | null; email: string; status: string } | null }[] }[]).map((f) => ({
        id: f.id, name: f.display_name,
        adults: f.family_members.map((m) => ({ user_id: m.user_id, name: m.profiles?.display_name || m.profiles?.email || "Adult", active: m.profiles?.status === "active" })),
      })));
      if (year.data) {
        const { data: reqs } = await supabase.from("requirements")
          .select("id,title,sign_template_id,family_requirements(status)")
          .eq("school_year_id", year.data.id).eq("kind", "document").eq("active", true).order("sort_order");
        if (cancelled) return;
        const rows = ((reqs ?? []) as unknown as { id: string; title: string; sign_template_id: string | null; family_requirements: { status: string }[] }[])
          .filter((r) => !r.sign_template_id || r.sign_template_id === template.id)
          .map((r) => ({ id: r.id, title: r.title, sign_template_id: r.sign_template_id, outstanding: r.family_requirements.filter((x) => x.status === "outstanding" || x.status === "sent").length }));
        setRequirements(rows);
        setRequirementId((current) => current || rows[0]?.id || "");
      }
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
    if (mode === "requirement") {
      args.p_requirement = requirementId || null;
    } else {
      args.p_requirement = trackId || null;
      args.p_family_ids = [...chosen];
      const override: Record<string, string[]> = {};
      for (const id of chosen) if (assignments[id]?.length === template.signers_required) override[id] = assignments[id];
      args.p_assignments = override;
    }
    const { data, error: rpcError } = await supabase.rpc("sign_send", args);
    setBusy(false);
    if (rpcError) { setError(friendlyError(rpcError)); return; }
    const r = data as { sent: unknown[]; skipped: { family_id: string; reason: string }[] };
    setResult({ sent: r.sent.length, skipped: r.skipped.map((s) => ({ name: nameOf(s.family_id), reason: REASONS[s.reason] ?? s.reason })) });
    if (r.sent.length) onSent();
  }

  const ready = mode === "requirement" ? !!requirementId : chosen.size > 0;

  return <section className="send-panel" aria-label={`Send ${template.title}`}>
    <div className="field-editor-bar">
      <button type="button" className="sign-big secondary compact" onClick={onClose}>← Back to documents</button>
      <h2>Send “{template.title}”</h2>
    </div>
    <p className="sign-hint">
      {template.signers_required === 2
        ? "Two people sign a copy, each in their own session, when the household has two adults (by default the first two to join). A household with one adult gets the same document, and that adult signs signer 1's fields; signer 2's fields are left off."
        : "One adult signs each copy. By default that is the first adult in the household."} Everyone must have accepted their invitation and have a name on their account before they can sign.
    </p>

    <p className="sign-hint">
      When this is tied to a required document, each household&rsquo;s Paperwork status follows the signing on its own: it shows Sent when you send it, Complete once everyone it was sent to has signed and the signed copy is sealed, and goes back to Outstanding if you cancel it. Reminders and the compliance matrix use that status.
    </p>

    <div className="send-panel-grid">
      <fieldset>
        <legend>Who gets it</legend>
        <label className="checkbox-field"><input type="radio" name="mode" checked={mode === "requirement"} onChange={() => setMode("requirement")} /> Every household that still owes a required document this year</label>
        {mode === "requirement" && <label><span className="field-caption">Required document</span>
          <select value={requirementId} onChange={(e) => setRequirementId(e.target.value)}>
            {!requirements.length && <option value="">No required documents this year (add one under Compliance)</option>}
            {requirements.map((r) => <option key={r.id} value={r.id}>{r.title} · {r.outstanding} outstanding</option>)}
          </select></label>}
        <label className="checkbox-field"><input type="radio" name="mode" checked={mode === "families"} onChange={() => setMode("families")} /> Households I pick</label>
        {mode === "families" && <>
          <label><span className="field-caption">Keep track of it as <i>optional</i></span>
            <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
              <option value="">Do not track it as a required document</option>
              {requirements.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select></label>
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
      <p>{result.sent === 0 ? "Nothing was sent." : `Sent to ${result.sent} ${result.sent === 1 ? "household" : "households"}. Each signer has been notified in the app and by email.`}</p>
      {result.skipped.length > 0 && <ul>{result.skipped.map((s, i) => <li key={i}>{s.name} {s.reason}.</li>)}</ul>}
    </div>}
  </section>;
}
