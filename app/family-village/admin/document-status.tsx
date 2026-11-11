"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { isSettled, statusLabel, statusTone, type FamilyRequirement, type Requirement } from "../../../lib/compliance";

type Family = { id: string; display_name: string };
type Row = Pick<FamilyRequirement, "id" | "requirement_id" | "family_id" | "status" | "signed_document_id" | "signed_at" | "note">;
type Editing = { requirement: Requirement; family: Family; row: Row | null };

/**
 * Who still needs to sign what: every household against every required document
 * for a school year. Clicking a cell lets an administrator record a signature
 * collected on paper, excuse a household, or reset it. Signatures made in the
 * portal update these cells by themselves.
 */
export default function DocumentStatus({ actorUserId, yearId, refreshKey }: { actorUserId: string; yearId: string; refreshKey: number }) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [families, setFamilies] = useState<Family[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !yearId) { setLoaded(true); return; }
    const [reqs, fams] = await Promise.all([
      supabase.from("requirements")
        .select("id,school_year_id,kind,title,description,active,sort_order,document_id,sign_template_id,amount_per_family,amount_per_child,payment_url,due_on")
        .eq("school_year_id", yearId).eq("kind", "document").eq("active", true).order("sort_order").order("title"),
      supabase.from("families").select("id,display_name").order("display_name"),
    ]);
    const list = (reqs.data ?? []) as Requirement[];
    setRequirements(list);
    setFamilies((fams.data ?? []) as Family[]);
    if (list.length) {
      const { data } = await supabase.from("family_requirements")
        .select("id,requirement_id,family_id,status,signed_document_id,signed_at,note").in("requirement_id", list.map((r) => r.id));
      setRows((data ?? []) as Row[]);
    } else {
      setRows([]);
    }
    setLoaded(true);
  }, [yearId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch when the year or the list changes
  useEffect(() => { load(); }, [load, refreshKey]);

  const cell = (requirementId: string, familyId: string) =>
    rows.find((r) => r.requirement_id === requirementId && r.family_id === familyId) ?? null;

  async function save(target: Editing, patch: Partial<FamilyRequirement>) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { requirement, family, row } = target;
    const result = row
      ? await supabase.from("family_requirements").update({ ...patch, updated_by: actorUserId }).eq("id", row.id)
      : await supabase.from("family_requirements").insert({ requirement_id: requirement.id, family_id: family.id, updated_by: actorUserId, ...patch });
    if (result.error) { setMessage(result.error.message); return; }
    await supabase.from("audit_log").insert({
      actor_user_id: actorUserId, action: "requirement_status_changed", subject_type: "family_requirement",
      subject_id: row?.id ?? requirement.id, detail: { family: family.display_name, requirement: requirement.title, ...patch },
    });
    setEditing(null);
    setMessage(`Updated ${family.display_name}: ${requirement.title}.`);
    await load();
  }

  if (!loaded) return <p className="portal-empty">Loading…</p>;
  if (!requirements.length) return <p className="portal-empty">No documents are required for this school year yet. Tick &ldquo;Required of every family&rdquo; on a document above.</p>;

  const upToDate = families.filter((f) => requirements.every((r) => { const row = cell(r.id, f.id); return row && isSettled(row.status); })).length;

  return <div className="document-status">
    <p className="compliance-summary"><b>{upToDate}</b> of <b>{families.length}</b> households have signed everything required.</p>
    {message && <p className="admin-form-status" role="status">{message}</p>}
    <div className="scroller compliance-matrix-wrap">
      <table className="compliance-matrix">
        <thead><tr><th scope="col">Household</th>{requirements.map((r) => <th key={r.id} scope="col">{r.title}</th>)}</tr></thead>
        <tbody>
          {families.map((f) => <tr key={f.id}>
            <th scope="row">{f.display_name}</th>
            {requirements.map((r) => {
              const row = cell(r.id, f.id);
              return <td key={r.id}>
                <button type="button" className={`matrix-cell ${row ? statusTone(row.status) : "missing"}`}
                  onClick={() => setEditing({ requirement: r, family: f, row })} title={`${f.display_name}: ${r.title}`}>
                  {row ? statusLabel(r.kind, row as FamilyRequirement) : "Not sent"}
                </button>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    {editing && <CellEditor target={editing} onSave={(patch) => save(editing, patch)} onCancel={() => setEditing(null)} />}
  </div>;
}

function CellEditor({ target, onSave, onCancel }: { target: Editing; onSave: (patch: Partial<FamilyRequirement>) => void; onCancel: () => void }) {
  const { requirement, family, row } = target;
  const [note, setNote] = useState(row?.note ?? "");
  return <div className="compliance-editor-backdrop" role="dialog" aria-modal="true" aria-label={`${family.display_name}: ${requirement.title}`}>
    <div className="compliance-editor">
      <p className="card-kicker">{family.display_name}</p>
      <h3>{requirement.title}</h3>
      <p className="field-note">Families sign inside Family Village. Use these only to record a signature collected on paper, or to excuse a household.</p>
      <div className="portal-form compliance-form">
        <label><span className="field-caption">Note <i>optional</i></span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown to the family" /></label>
      </div>
      <div className="compliance-editor-actions">
        <button type="button" className="sign-big compact" onClick={() => onSave({ status: "complete", signed_at: new Date().toISOString(), note: note || null })}>Mark signed on paper</button>
        <button type="button" className="sign-big secondary compact" onClick={() => onSave({ status: "waived", note: note || null })}>Not required</button>
        {row && row.status !== "outstanding" && <button type="button" className="sign-big secondary compact" onClick={() => onSave({ status: "outstanding", signed_at: null, note: note || null })}>Reset to outstanding</button>}
        <button type="button" className="sign-big secondary compact" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>;
}
