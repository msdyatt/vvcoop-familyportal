"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  FamilyRequirement, Requirement, SchoolYear,
  duesFor, formatMoney, isSettled, statusLabel, statusTone,
} from "../../../lib/compliance";

type FamilyAdult = { user_id: string; profiles: { email: string; display_name: string | null; status: string } | null };
type FamilyRow = {
  id: string; display_name: string;
  children: { id: string; active: boolean }[];
  family_members: FamilyAdult[];
};

/**
 * Who has signed what, and who has paid -- one row per family, one column per
 * requirement. Everything an administrator needs to chase an outstanding
 * handbook or record a cheque without leaving the page.
 */
export default function ComplianceTab({ actorUserId }: { actorUserId: string }) {
  const [years, setYears] = useState<SchoolYear[]>([]);
  const [yearId, setYearId] = useState("");
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [families, setFamilies] = useState<FamilyRow[]>([]);
  const [rows, setRows] = useState<FamilyRequirement[]>([]);
  const [documents, setDocuments] = useState<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<{ requirement: Requirement; family: FamilyRow; row: FamilyRequirement | null } | null>(null);

  async function load(selectedYear?: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const { data: yearRows } = await supabase.from("school_years").select("id,label,starts_on,ends_on,is_current").order("label", { ascending: false });
    const allYears = (yearRows ?? []) as SchoolYear[];
    setYears(allYears);

    const activeYear = selectedYear || yearId || allYears.find((year) => year.is_current)?.id || allYears[0]?.id || "";
    setYearId(activeYear);

    if (!activeYear) { setRequirements([]); setRows([]); setLoading(false); return; }

    const [{ data: reqRows }, { data: familyRows }, { data: docRows }] = await Promise.all([
      supabase.from("requirements").select("id,school_year_id,kind,title,description,active,sort_order,document_id,amount_per_family,amount_per_child,payment_url,due_on")
        .eq("school_year_id", activeYear).order("sort_order").order("title"),
      supabase.from("families").select("id,display_name,children(id,active),family_members(user_id,profiles(email,display_name,status))").order("display_name"),
      // Candidates to attach to a document requirement -- anything with a file.
      supabase.from("documents").select("id,title,storage_path").not("storage_path", "is", null).order("created_at", { ascending: false }),
    ]);
    setDocuments((docRows ?? []).map((d) => ({ id: d.id, title: d.title })));

    const reqs = (reqRows ?? []) as Requirement[];
    setRequirements(reqs);
    setFamilies((familyRows ?? []) as unknown as FamilyRow[]);

    if (reqs.length) {
      const { data: statusRows } = await supabase
        .from("family_requirements")
        .select("id,requirement_id,family_id,status,signed_document_id,signed_at,signing_url,provider_document_id,amount_due,amount_paid,paid_at,payment_method,payment_reference,note")
        .in("requirement_id", reqs.map((r) => r.id));
      setRows((statusRows ?? []) as FamilyRequirement[]);
    } else {
      setRows([]);
    }
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- initial data fetch on mount; load() is re-invoked explicitly on year change, and listing it here would refetch on every render
  useEffect(() => { load(); }, []);

  async function log(action: string, subjectId: string, detail: Record<string, unknown>) {
    const supabase = getSupabaseBrowserClient();
    await supabase?.from("audit_log").insert({ actor_user_id: actorUserId, action, subject_type: "family_requirement", subject_id: subjectId, detail });
  }

  /** Creates a status row per family, so the requirement starts showing up for everyone. */
  async function openToAllFamilies(requirement: Requirement) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const existing = new Set(rows.filter((row) => row.requirement_id === requirement.id).map((row) => row.family_id));
    const missing = families.filter((family) => !existing.has(family.id));
    if (!missing.length) { setStatus(`Every family already has "${requirement.title}".`); return; }

    const inserts = missing.map((family) => ({
      requirement_id: requirement.id,
      family_id: family.id,
      status: "outstanding",
      // Captured now rather than derived later, so a child added mid-year does
      // not quietly change a figure the family has already been shown.
      amount_due: requirement.kind === "dues"
        ? duesFor(requirement, family.children.filter((child) => child.active).length)
        : null,
      updated_by: actorUserId,
    }));

    const { error } = await supabase.from("family_requirements").insert(inserts);
    if (error) { setStatus(error.message); return; }
    await log("requirement_opened", requirement.id, { title: requirement.title, families: missing.length });
    setStatus(`Opened "${requirement.title}" to ${missing.length} famil${missing.length === 1 ? "y" : "ies"}.`);
    await load();
  }

  async function saveCell(row: FamilyRequirement | null, requirement: Requirement, family: FamilyRow, patch: Partial<FamilyRequirement>) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    if (row) {
      const { error } = await supabase.from("family_requirements").update({ ...patch, updated_by: actorUserId }).eq("id", row.id);
      if (error) { setStatus(error.message); return; }
      await log("requirement_status_changed", row.id, { family: family.display_name, requirement: requirement.title, ...patch });
    } else {
      const { error } = await supabase.from("family_requirements").insert({
        requirement_id: requirement.id, family_id: family.id, updated_by: actorUserId,
        amount_due: requirement.kind === "dues" ? duesFor(requirement, family.children.filter((c) => c.active).length) : null,
        ...patch,
      });
      if (error) { setStatus(error.message); return; }
      await log("requirement_status_changed", requirement.id, { family: family.display_name, requirement: requirement.title, ...patch });
    }
    setEditing(null);
    setStatus(`Updated ${family.display_name} — ${requirement.title}.`);
    await load();
  }

  /** Re-derives dues from the family's current active children, on purpose. */
  async function recalculateDues(requirement: Requirement) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const affected = rows.filter((row) => row.requirement_id === requirement.id && row.status !== "complete");
    await Promise.all(affected.map((row) => {
      const family = families.find((f) => f.id === row.family_id);
      if (!family) return Promise.resolve();
      return supabase.from("family_requirements")
        .update({ amount_due: duesFor(requirement, family.children.filter((c) => c.active).length), updated_by: actorUserId })
        .eq("id", row.id);
    }));
    setStatus(`Recalculated ${affected.length} unpaid balance${affected.length === 1 ? "" : "s"}. Families already marked paid were left alone.`);
    await load();
  }

  /**
   * Sends the requirement's master PDF to one adult in the household and stores
   * the returned signing link on their compliance row, so the family signs from
   * inside the portal. Email is suppressed -- the link lives on the page.
   */
  async function sendForSignature(requirement: Requirement, family: FamilyRow, row: FamilyRequirement | null, signerEmail: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    if (!requirement.document_id) { setStatus(`"${requirement.title}" has no document attached. Upload it in Documents and link it to the requirement first.`); return; }

    let targetId = row?.id;
    if (!targetId) {
      const { data: created, error: createError } = await supabase.from("family_requirements")
        .insert({ requirement_id: requirement.id, family_id: family.id, updated_by: actorUserId })
        .select("id").single();
      if (createError) { setStatus(createError.message); return; }
      targetId = created.id;
    }

    setStatus(`Sending "${requirement.title}" to ${signerEmail}…`);
    const { data, error } = await supabase.functions.invoke("opensign-send", {
      body: {
        documentId: requirement.document_id,
        familyRequirementId: targetId,
        signers: [{ email: signerEmail }],
        sendEmail: false,
      },
    });
    if (error || data?.error) { setStatus(data?.error || "The signing link could not be created."); await load(); return; }
    await log("signature_link_created", targetId!, { family: family.display_name, requirement: requirement.title, signer: signerEmail });
    setStatus(data?.signingUrl
      ? `Signing link ready for ${family.display_name}. It is now on their dashboard.`
      : `Sent, but OpenSign returned no signing link — the family may need the emailed copy.`);
    setEditing(null);
    await load();
  }

  if (loading) return <p>Loading compliance…</p>;

  const cell = (requirementId: string, familyId: string) =>
    rows.find((row) => row.requirement_id === requirementId && row.family_id === familyId) ?? null;

  const completeFamilies = families.filter((family) =>
    requirements.length > 0 && requirements.every((req) => {
      const row = cell(req.id, family.id);
      return row && isSettled(row.status);
    })).length;

  return <section className="compliance-manage">
    <div className="compliance-toolbar">
      <label><span className="field-caption">School year</span>
        <select value={yearId} onChange={(event) => { setLoading(true); load(event.target.value); }}>
          {years.map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " · current" : ""}</option>)}
          {!years.length && <option value="">No years yet</option>}
        </select>
      </label>
      {requirements.length > 0 && <p className="compliance-summary">
        <b>{completeFamilies}</b> of <b>{families.length}</b> families are fully up to date
      </p>}
    </div>

    <p className="admin-form-status" role="status">{status || "Create a school year, add what families must sign or pay, then open each requirement to every household."}</p>

    <YearForm onSaved={load} onStatus={setStatus} />

    {yearId && <RequirementForm yearId={yearId} documents={documents} onSaved={load} onStatus={setStatus} />}

    {!requirements.length
      ? <p className="portal-empty">No requirements for this year yet.</p>
      : <>
        <div className="compliance-requirements">
          {requirements.map((req) => {
            const opened = rows.filter((row) => row.requirement_id === req.id).length;
            return <article key={req.id} className="compliance-requirement">
              <div>
                <b>{req.title}</b>
                <span>{req.kind === "dues"
                  ? `${formatMoney(Number(req.amount_per_family ?? 0))} per family + ${formatMoney(Number(req.amount_per_child ?? 0))} per child`
                  : req.document_id
                    ? `Signature required · ${documents.find((d) => d.id === req.document_id)?.title ?? "document attached"}`
                    : "Signature required · no document attached yet"} · open to {opened} of {families.length}</span>
              </div>
              <div className="row-actions">
                {opened < families.length && <button onClick={() => openToAllFamilies(req)}>Open to all families</button>}
                {req.kind === "dues" && opened > 0 && <button onClick={() => recalculateDues(req)}>Recalculate balances</button>}
                {req.kind === "document" && <AttachDocument requirement={req} documents={documents} onSaved={load} onStatus={setStatus} />}
              </div>
            </article>;
          })}
        </div>

        <div className="scroller compliance-matrix-wrap">
          <table className="compliance-matrix">
            <thead>
              <tr>
                <th scope="col">Family</th>
                {requirements.map((req) => <th key={req.id} scope="col">{req.title}</th>)}
              </tr>
            </thead>
            <tbody>
              {families.map((family) => <tr key={family.id}>
                <th scope="row">{family.display_name}</th>
                {requirements.map((req) => {
                  const row = cell(req.id, family.id);
                  return <td key={req.id}>
                    <button
                      className={`matrix-cell ${row ? statusTone(row.status) : "missing"}`}
                      onClick={() => setEditing({ requirement: req, family, row })}
                      title={`${family.display_name} — ${req.title}`}
                    >
                      {row ? statusLabel(req.kind, row) : "Not opened"}
                    </button>
                  </td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}

    {editing && <CellEditor
      requirement={editing.requirement}
      family={editing.family}
      row={editing.row}
      onCancel={() => setEditing(null)}
      onSave={(patch) => saveCell(editing.row, editing.requirement, editing.family, patch)}
      onSend={(email) => sendForSignature(editing.requirement, editing.family, editing.row, email)}
    />}
  </section>;
}

function YearForm({ onSaved, onStatus }: { onSaved: () => void; onStatus: (message: string) => void }) {
  const [label, setLabel] = useState("");
  const [makeCurrent, setMakeCurrent] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !label.trim()) return;
    setBusy(true);
    // Only one year may be current, enforced by a partial unique index -- so
    // stand the old one down first rather than letting the insert collide.
    if (makeCurrent) await supabase.from("school_years").update({ is_current: false }).eq("is_current", true);
    const { error } = await supabase.from("school_years").insert({ label: label.trim(), is_current: makeCurrent });
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    setLabel("");
    onSaved();
  }

  return <form onSubmit={submit} className="portal-form compliance-form">
    <label><span className="field-caption">Add a school year</span>
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="2026–27" disabled={busy} />
    </label>
    <label className="checkbox-field">
      <input type="checkbox" checked={makeCurrent} onChange={(event) => setMakeCurrent(event.target.checked)} /> Make this the current year
    </label>
    <button disabled={busy}>{busy ? "Adding…" : "Add year"}</button>
  </form>;
}

/** Links a stored PDF to a document requirement, so it can be sent for signature. */
function AttachDocument({ requirement, documents, onSaved, onStatus }: {
  requirement: Requirement;
  documents: { id: string; title: string }[];
  onSaved: () => void;
  onStatus: (message: string) => void;
}) {
  const [value, setValue] = useState(requirement.document_id ?? "");

  async function attach(documentId: string) {
    setValue(documentId);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.from("requirements").update({ document_id: documentId || null }).eq("id", requirement.id);
    if (error) { onStatus(error.message); return; }
    onStatus(documentId ? `Attached a document to "${requirement.title}".` : `Removed the document from "${requirement.title}".`);
    onSaved();
  }

  return <select aria-label={`Document for ${requirement.title}`} value={value} onChange={(event) => attach(event.target.value)}>
    <option value="">No document attached</option>
    {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
  </select>;
}

function RequirementForm({ yearId, documents, onSaved, onStatus }: { yearId: string; documents: { id: string; title: string }[]; onSaved: () => void; onStatus: (message: string) => void }) {
  const [kind, setKind] = useState<"document" | "dues">("document");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [perFamily, setPerFamily] = useState("300");
  const [perChild, setPerChild] = useState("150");
  const [paymentUrl, setPaymentUrl] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !title.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("requirements").insert({
      school_year_id: yearId,
      kind,
      title: title.trim(),
      description: description.trim() || null,
      due_on: dueOn || null,
      ...(kind === "dues"
        ? { amount_per_family: Number(perFamily) || 0, amount_per_child: Number(perChild) || 0, payment_url: paymentUrl.trim() || null }
        : { document_id: documentId || null }),
    });
    setBusy(false);
    if (error) { onStatus(error.message); return; }
    setTitle(""); setDescription(""); setPaymentUrl(""); setDocumentId("");
    onSaved();
  }

  return <form onSubmit={submit} className="portal-form compliance-form">
    <label><span className="field-caption">Type</span>
      <select value={kind} onChange={(event) => setKind(event.target.value as "document" | "dues")}>
        <option value="document">Document to sign</option>
        <option value="dues">Dues to pay</option>
      </select>
    </label>
    <label><span className="field-caption">Title</span>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === "dues" ? "Annual dues" : "Family handbook"} disabled={busy} />
    </label>
    <label><span className="field-caption">Description <i>optional</i></span>
      <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Shown to families" disabled={busy} />
    </label>
    <label><span className="field-caption">Due date <i>optional</i></span>
      <input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} disabled={busy} />
    </label>
    {kind === "document" && <label><span className="field-caption">Document <i>the PDF families sign</i></span>
      <select value={documentId} onChange={(event) => setDocumentId(event.target.value)} disabled={busy}>
        <option value="">Choose a document…</option>
        {documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}
      </select>
    </label>}
    {kind === "dues" && <>
      <label><span className="field-caption">Per family</span>
        <input type="number" min={0} step="0.01" value={perFamily} onChange={(event) => setPerFamily(event.target.value)} disabled={busy} />
      </label>
      <label><span className="field-caption">Per child</span>
        <input type="number" min={0} step="0.01" value={perChild} onChange={(event) => setPerChild(event.target.value)} disabled={busy} />
      </label>
      <label><span className="field-caption">Payment link <i>your Crowded link</i></span>
        <input value={paymentUrl} onChange={(event) => setPaymentUrl(event.target.value)} placeholder="https://…" disabled={busy} />
      </label>
    </>}
    <button disabled={busy}>{busy ? "Adding…" : "Add requirement"}</button>
  </form>;
}

/** Record a payment, mark a signature received, or waive an item. */
function CellEditor({ requirement, family, row, onSave, onCancel, onSend }: {
  requirement: Requirement;
  family: FamilyRow;
  row: FamilyRequirement | null;
  onSave: (patch: Partial<FamilyRequirement>) => void;
  onCancel: () => void;
  onSend: (signerEmail: string) => void;
}) {
  const isDues = requirement.kind === "dues";
  // Any adult may sign for the household and the first signature settles it, so
  // the link goes to one person rather than everyone -- the OpenSign plan meters
  // signatures, and sending to every adult would double the yearly draw.
  const adults = (family.family_members ?? []).filter((m) => m.profiles && m.profiles.status === "active");
  const [signer, setSigner] = useState(adults[0]?.profiles?.email ?? "");
  const [amountPaid, setAmountPaid] = useState(String(row?.amount_paid ?? 0));
  const [method, setMethod] = useState(row?.payment_method ?? "Crowded");
  const [reference, setReference] = useState(row?.payment_reference ?? "");
  const [note, setNote] = useState(row?.note ?? "");

  return <div className="compliance-editor-backdrop" role="dialog" aria-modal="true" aria-label={`${family.display_name} — ${requirement.title}`}>
    <div className="compliance-editor">
      <p className="card-kicker">{family.display_name}</p>
      <h3>{requirement.title}</h3>
      {isDues && row?.amount_due != null && <p className="compliance-editor-owed">Owes {formatMoney(Number(row.amount_due))}</p>}

      {!isDues && <div className="portal-form compliance-form">
        <label><span className="field-caption">Send the signing link to</span>
          <select value={signer} onChange={(event) => setSigner(event.target.value)}>
            {adults.map((adult) => <option key={adult.user_id} value={adult.profiles!.email}>
              {adult.profiles!.display_name || adult.profiles!.email}
            </option>)}
            {!adults.length && <option value="">No active adults on this household</option>}
          </select>
        </label>
        {row?.signing_url && <p className="compliance-editor-owed">A signing link is already on this family&rsquo;s dashboard.</p>}
      </div>}

      {isDues && <div className="portal-form compliance-form">
        <label><span className="field-caption">Amount received</span>
          <input type="number" min={0} step="0.01" value={amountPaid} onChange={(event) => setAmountPaid(event.target.value)} />
        </label>
        <label><span className="field-caption">Method</span>
          <input value={method} onChange={(event) => setMethod(event.target.value)} placeholder="Crowded / cheque / cash" />
        </label>
        <label><span className="field-caption">Reference <i>optional</i></span>
          <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Cheque no., transfer id" />
        </label>
      </div>}

      <div className="portal-form compliance-form">
        <label><span className="field-caption">Note <i>optional</i></span>
          <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Shown to the family" />
        </label>
      </div>

      <div className="compliance-editor-actions">
        {!isDues && <button disabled={!signer} onClick={() => onSend(signer)}>
          {row?.signing_url ? "Resend signing link" : "Create signing link"}
        </button>}
        <button className={isDues ? "" : "ghost"} onClick={() => onSave(isDues
          ? { status: "complete", amount_paid: Number(amountPaid) || 0, paid_at: new Date().toISOString(), payment_method: method || null, payment_reference: reference || null, note: note || null }
          : { status: "complete", signed_at: new Date().toISOString(), note: note || null })}>
          {isDues ? "Record payment" : "Mark signed"}
        </button>
        <button className="ghost" onClick={() => onSave({ status: "waived", note: note || null })}>Not required</button>
        {row && row.status !== "outstanding" && <button className="ghost" onClick={() => onSave({ status: "outstanding", paid_at: null, signed_at: null, amount_paid: 0, note: note || null })}>Reset to outstanding</button>}
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>;
}
