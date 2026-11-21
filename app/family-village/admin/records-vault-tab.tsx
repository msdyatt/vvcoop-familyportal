"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { coopWallTime } from "../../../lib/coop-time";
import { formatCents, parseDollars } from "../../../lib/dues";
import {
  RECORD_CATEGORIES, RECORD_FILE_ACCEPT, categoryLabel, describeRecordEvent, eraseBlocker, expiryState, formatBytes, longDate,
  parseTags, recordFileProblem, recordFileUrl, removeErasedFiles, sensitiveByDefault, snapshotChanges, uploadRecordFile,
  type RecordSnapshot,
} from "../../../lib/records-vault";

/**
 * Admin, Records, Records vault: the co-op's own paperwork (insurance, the lease, nonprofit and tax records) and its
 * key facts. Everything here goes through the vault's functions (supabase/migrations/20261114110000_records_vault.sql),
 * which require an administrator who is not a reviewer account and has used their second factor. Opening a file and
 * revealing a sensitive fact are logged; a record is archived before it can be erased.
 */

type Person = { display_name: string | null } | null;
type FileRow = {
  id: string; version_no: number; file_name: string; content_type: string; size_bytes: number; sha256: string | null;
  change_note: string | null; created_at: string; uploader: Person;
};
type VaultRecord = {
  id: string; title: string; category: string; issuer: string | null; reference_number: string | null; effective_on: string | null;
  expires_on: string | null; amount_cents: number | null; notes: string | null; tags: string[]; sensitive: boolean; retain_until: string | null;
  version: number; archived_at: string | null; archive_reason: string | null; created_at: string; updated_at: string;
  creator: Person; archiver: Person; org_record_files: FileRow[];
};
type Revision = { id: string; version: number; snapshot: RecordSnapshot; change_note: string | null; created_at: string; changer: Person };
type AccessRow = { id: number; action: string; detail: Record<string, unknown> | null; created_at: string; actor_user_id: string | null };
type Fact = {
  key: string; label: string; value: string | null; sensitive: boolean; has_value: boolean; version: number;
  updated_at: string | null; updated_by_name: string | null;
};
type FactRevision = { version: number; value: string | null; change_note: string | null; changed_by_name: string | null; created_at: string };

const FILE_COLUMNS = "id,version_no,file_name,content_type,size_bytes,sha256,change_note,created_at,uploader:profiles!org_record_files_uploaded_by_fkey(display_name)";
const RECORD_COLUMNS = "id,title,category,issuer,reference_number,effective_on,expires_on,amount_cents,notes,tags,sensitive,retain_until,version,archived_at,archive_reason,created_at,updated_at,"
  + "creator:profiles!org_records_created_by_fkey(display_name),archiver:profiles!org_records_archived_by_fkey(display_name),"
  + `org_record_files(${FILE_COLUMNS})`;

const who = (person: Person) => person?.display_name || "a former administrator";
const when = (instant: string) => new Date(instant).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const coopToday = () => coopWallTime(new Date()).date;
const currentFile = (record: VaultRecord) => [...record.org_record_files].sort((a, b) => b.version_no - a.version_no)[0] ?? null;

async function openFile(file: FileRow, purpose: "view" | "download") {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error("Not connected.");
  const url = await recordFileUrl(supabase, file.id, purpose, file.file_name);
  if (purpose === "view") { window.open(url, "_blank", "noopener,noreferrer"); return; }
  const link = document.createElement("a");
  link.href = url; link.rel = "noopener"; link.download = file.file_name;
  document.body.appendChild(link); link.click(); link.remove();
}

export default function RecordsVaultTab() {
  const [view, setView] = useState<"records" | "facts">("records");
  const [message, setMessage] = useState("");
  return <div className="dues-admin records-vault">
    <header className="dues-admin-head">
      <div><p className="card-kicker">Records</p><h2>Records vault</h2></div>
      <nav className="dues-admin-nav" aria-label="Records vault sections">
        <button type="button" className={view === "records" ? "active" : ""} aria-pressed={view === "records"} onClick={() => { setView("records"); setMessage(""); }}>Records</button>
        <button type="button" className={view === "facts" ? "active" : ""} aria-pressed={view === "facts"} onClick={() => { setView("facts"); setMessage(""); }}>Key facts</button>
      </nav>
    </header>
    <p className="dues-note">Administrators only. Every file opened and every sensitive value shown is written to the activity log.</p>
    {message && <p className="dues-flash" role="status">{message}</p>}
    {view === "records" ? <RecordsView setMessage={setMessage} /> : <FactsView setMessage={setMessage} />}
  </div>;
}

/* ---------- Records ---------- */

function RecordsView({ setMessage }: { setMessage: (m: string) => void }) {
  const [records, setRecords] = useState<VaultRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState({ search: "", category: "", archived: false });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const today = coopToday();

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("org_records").select(RECORD_COLUMNS).order("title");
    if (error) setMessage(error.message);
    setRecords((data ?? []) as unknown as VaultRecord[]);
    setLoaded(true);
  }, [setMessage]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return records
      .filter((r) => (filters.archived ? !!r.archived_at : !r.archived_at))
      .filter((r) => !filters.category || r.category === filters.category)
      .filter((r) => !q || [r.title, r.issuer, r.reference_number, r.notes, ...r.tags].some((v) => v?.toLowerCase().includes(q)))
      // Soonest expiry first, then the ones that never expire, by title.
      .sort((a, b) => (a.expires_on ?? "9999").localeCompare(b.expires_on ?? "9999") || a.title.localeCompare(b.title));
  }, [records, filters]);
  const archivedCount = records.filter((r) => r.archived_at).length;

  return <>
    <div className="compliance-toolbar">
      <label>Search<input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Title, issuer, number or tag" /></label>
      <label>Category<select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
        <option value="">All</option>{RECORD_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select></label>
      <label className="dues-agree vault-toggle"><input type="checkbox" checked={filters.archived} onChange={(e) => setFilters({ ...filters, archived: e.target.checked })} /> <span>Show archived ({archivedCount})</span></label>
    </div>
    {!adding && <div className="dues-actions"><button type="button" onClick={() => { setAdding(true); setMessage(""); }}>Add a record</button></div>}

    {adding && <section className="dues-setup">
      <h3>Add a record</h3>
      <RecordForm withFile onCancel={() => setAdding(false)} onSaved={async (id, note) => { setAdding(false); setMessage(note); setFilters({ search: "", category: "", archived: false }); await load(); setOpenId(id); }} setMessage={setMessage} />
    </section>}

    <ul className="dues-ledger vault-list">
      {shown.map((r) => {
        const expiry = r.archived_at ? null : expiryState(r.expires_on, today);
        const file = currentFile(r);
        return <li key={r.id}>
          <button type="button" className="dues-ledger-row vault-row" aria-expanded={openId === r.id} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
            <b>{r.title}</b>
            <span>{categoryLabel(r.category)}{r.issuer ? ` · ${r.issuer}` : ""}</span>
            <span>{r.expires_on ? `Expires ${longDate(r.expires_on)}` : "No expiry"}</span>
            <span className="vault-chips">
              {expiry && expiry.tone !== "ok" && <span className={`vault-chip vault-chip-${expiry.tone}`}>{expiry.label}</span>}
              {r.sensitive && <span className="vault-chip vault-chip-sensitive">Sensitive</span>}
              {r.archived_at && <span className="vault-chip vault-chip-archived">Archived</span>}
              <span className="vault-chip">{file ? `File v${file.version_no}` : "No file"}</span>
            </span>
          </button>
          {openId === r.id && <RecordDetail record={r} today={today} reload={load} setMessage={setMessage} onErased={() => setOpenId(null)} />}
        </li>;
      })}
    </ul>
    {loaded && !shown.length && <p className="portal-empty">{records.length ? "No records match." : "No records yet. Add the insurance policy or the lease to start."}</p>}
  </>;
}

/** Add (with an optional first file) or edit (with a reason). The database checks the same things again. */
function RecordForm({ record, withFile = false, onSaved, onCancel, setMessage }: {
  record?: VaultRecord; withFile?: boolean; onSaved: (id: string, note: string) => Promise<void> | void; onCancel: () => void; setMessage: (m: string) => void;
}) {
  const [category, setCategory] = useState(record?.category ?? "");
  const [sensitive, setSensitive] = useState(record?.sensitive ?? false);
  const [sensitiveTouched, setSensitiveTouched] = useState(!!record);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const d = new FormData(event.currentTarget);
    const text = (name: string) => String(d.get(name) ?? "").trim();
    const date = (name: string) => text(name) || null;
    const amountText = text("amount");
    const amount = amountText ? parseDollars(amountText) : null;
    if (amountText && amount === null) { setMessage("Enter the amount as dollars, for example 1250.00."); return; }
    const effective = date("effective_on"), expires = date("expires_on");
    if (effective && expires && expires < effective) { setMessage("The expiry date is before the effective date."); return; }
    const file = d.get("file");
    const upload = withFile && file instanceof File && file.size > 0 ? file : null;
    if (upload) { const problem = recordFileProblem(upload); if (problem) { setMessage(problem); return; } }
    const fields = {
      p_title: text("title"), p_category: category, p_issuer: text("issuer") || null, p_reference: text("reference") || null,
      p_effective_on: effective, p_expires_on: expires, p_amount_cents: amount, p_notes: text("notes") || null,
      p_tags: parseTags(text("tags")), p_sensitive: sensitive, p_retain_until: date("retain_until"),
    };
    setBusy(true); setMessage("");
    try {
      if (record) {
        const { error } = await supabase.rpc("admin_update_record", { p_record: record.id, ...fields, p_change_note: text("why") });
        if (error) throw new Error(error.message);
        await onSaved(record.id, "Saved. The earlier version is kept in the history.");
        return;
      }
      const { data: id, error } = await supabase.rpc("admin_create_record", fields);
      if (error || !id) throw new Error(error?.message ?? "The record could not be added.");
      let note = upload ? "Record added with its file." : "Record added. Add the file when you have it.";
      if (upload) {
        try { await uploadRecordFile(supabase, id as string, upload, null); }
        catch (uploadError) { note = `Record added, but the file did not upload: ${uploadError instanceof Error ? uploadError.message : "unknown error"}. Add it from the record.`; }
      }
      await onSaved(id as string, note);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="vault-form" onSubmit={submit}>
    <label className="vault-wide">Title<input name="title" required maxLength={160} defaultValue={record?.title ?? ""} placeholder="General liability policy 2026–27" disabled={busy} /></label>
    <label>Category<select required value={category} disabled={busy} onChange={(e) => { setCategory(e.target.value); if (!sensitiveTouched) setSensitive(sensitiveByDefault(e.target.value)); }}>
      <option value="" disabled>Choose…</option>{RECORD_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select></label>
    <label>Issuer<input name="issuer" maxLength={160} defaultValue={record?.issuer ?? ""} placeholder="Insurer, landlord, agency" disabled={busy} /></label>
    <label>Reference number<input name="reference" maxLength={120} defaultValue={record?.reference_number ?? ""} placeholder="Policy or contract number" disabled={busy} /></label>
    <label>Amount ($) <span className="field-caption">optional</span><input name="amount" inputMode="decimal" defaultValue={record?.amount_cents != null ? (record.amount_cents / 100).toFixed(2) : ""} placeholder="Premium, rent or fee" disabled={busy} /></label>
    <label>Effective<input name="effective_on" type="date" defaultValue={record?.effective_on ?? ""} disabled={busy} /></label>
    <label>Expires<input name="expires_on" type="date" defaultValue={record?.expires_on ?? ""} disabled={busy} /></label>
    <label>Keep until <span className="field-caption">optional</span><input name="retain_until" type="date" defaultValue={record?.retain_until ?? ""} disabled={busy} /></label>
    <label>Tags <span className="field-caption">separated by commas</span><input name="tags" defaultValue={record?.tags.join(", ") ?? ""} placeholder="liability, building" disabled={busy} /></label>
    <label className="vault-wide">Notes<textarea name="notes" maxLength={4000} rows={3} defaultValue={record?.notes ?? ""} disabled={busy} /></label>
    <label className="dues-agree vault-wide"><input type="checkbox" checked={sensitive} disabled={busy} onChange={(e) => { setSensitive(e.target.checked); setSensitiveTouched(true); }} /> <span>Sensitive (tax IDs, bank details, signatures). Nonprofit, tax and financial records start out sensitive.</span></label>
    {withFile && <label className="vault-wide">File <span className="field-caption">PDF or photo, up to 20 MB; optional now</span><input name="file" type="file" accept={RECORD_FILE_ACCEPT} disabled={busy} /></label>}
    {record && <label className="vault-wide">Why are you changing it?<input name="why" required maxLength={500} disabled={busy} /></label>}
    <p className="dues-note vault-wide">How long to keep each kind of record is a question for the co-op&rsquo;s attorney or accountant. With a keep-until date set, the record cannot be erased before it.</p>
    <div className="dues-actions vault-wide">
      <button disabled={busy}>{busy ? "Saving…" : record ? "Save change" : "Add record"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

function RecordDetail({ record, today, reload, setMessage, onErased }: {
  record: VaultRecord; today: string; reload: () => Promise<void>; setMessage: (m: string) => void; onErased: () => void;
}) {
  const [mode, setMode] = useState<"none" | "edit" | "upload" | "archive" | "erase">("none");
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const files = useMemo(() => [...record.org_record_files].sort((a, b) => b.version_no - a.version_no), [record.org_record_files]);
  const archived = !!record.archived_at;

  async function rpc(fn: string, args: Record<string, unknown>, done: string): Promise<boolean> {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return false;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { setMessage(error.message); return false; }
    setMessage(done); setMode("none"); await reload();
    return true;
  }

  async function open(file: FileRow, purpose: "view" | "download") {
    setMessage("");
    try { await openFile(file, purpose); } catch (error) { setMessage(error instanceof Error ? error.message : "The file could not be opened."); }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const d = new FormData(event.currentTarget);
    const file = d.get("file");
    if (!(file instanceof File) || file.size === 0) { setMessage("Choose a file."); return; }
    const note = String(d.get("note") ?? "").trim();
    if (files.length && !note) { setMessage("Say what changed in this version."); return; }
    setBusy(true); setMessage("");
    try {
      const version = await uploadRecordFile(supabase, record.id, file, note || null);
      setMessage(version > 1 ? `Version ${version} added. The earlier versions are kept.` : "File added.");
      setMode("none"); await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The file could not be added.");
    } finally {
      setBusy(false);
    }
  }

  async function erase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const d = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("admin_erase_record", { p_record: record.id, p_confirm_title: String(d.get("confirm") ?? ""), p_reason: String(d.get("reason") ?? "") });
    if (error) { setBusy(false); setMessage(error.message); return; }
    const paths = ((data as { storage_paths?: string[] } | null)?.storage_paths) ?? [];
    const leftover = await removeErasedFiles(supabase, paths);
    setBusy(false);
    setMessage(leftover
      ? `Erased. The record is gone, but its files could not all be removed from storage (${leftover}). Nothing points at them; ask for help clearing them.`
      : `Erased "${record.title}"${paths.length ? ` and its ${paths.length} file${paths.length === 1 ? "" : "s"}` : ""}. The activity log keeps a line saying it was erased.`);
    onErased(); await reload();
  }

  const blocker = eraseBlocker(record, today);

  return <div className="dues-tools vault-detail">
    <dl className="vault-fields">
      <div><dt>Category</dt><dd>{categoryLabel(record.category)}</dd></div>
      <div><dt>Issuer</dt><dd>{record.issuer || <em>Not set</em>}</dd></div>
      <div><dt>Reference number</dt><dd>{record.reference_number || <em>Not set</em>}</dd></div>
      <div><dt>Amount</dt><dd>{record.amount_cents != null ? formatCents(record.amount_cents) : <em>Not set</em>}</dd></div>
      <div><dt>Effective</dt><dd>{record.effective_on ? longDate(record.effective_on) : <em>Not set</em>}</dd></div>
      <div><dt>Expires</dt><dd>{record.expires_on ? longDate(record.expires_on) : <em>Does not expire</em>}</dd></div>
      <div><dt>Keep until</dt><dd>{record.retain_until ? longDate(record.retain_until) : <em>Not set</em>}</dd></div>
      <div><dt>Tags</dt><dd>{record.tags.length ? record.tags.join(", ") : <em>None</em>}</dd></div>
      {record.notes && <div className="vault-wide"><dt>Notes</dt><dd className="vault-notes">{record.notes}</dd></div>}
    </dl>
    <p className="dues-note">Added {when(record.created_at)} by {who(record.creator)} · version {record.version}{record.sensitive ? " · sensitive" : ""}.
      {archived && ` Archived ${when(record.archived_at!)} by ${who(record.archiver)}: ${record.archive_reason}`}</p>

    <section className="vault-files" aria-label="Files">
      <h4>File{files.length > 1 ? ` (${files.length} versions)` : ""}</h4>
      {files.length ? <ol className="vault-file-list">
        {files.map((f, i) => <li key={f.id} className={i === 0 ? "current" : ""}>
          <div>
            <b>v{f.version_no}{i === 0 ? " (current)" : ""}</b> {f.file_name}
            <small>{formatBytes(f.size_bytes)} · added {when(f.created_at)} by {who(f.uploader)}{f.change_note ? ` · ${f.change_note}` : ""}</small>
            {f.sha256 && <small className="vault-hash" title={f.sha256}>SHA-256 {f.sha256.slice(0, 16)}…</small>}
          </div>
          <div className="dues-actions">
            <button type="button" className="ghost" onClick={() => open(f, "view")}>View</button>
            <button type="button" className="ghost" onClick={() => open(f, "download")}>Download</button>
          </div>
        </li>)}
      </ol> : <p className="dues-note">No file yet.</p>}
    </section>

    {!archived && <div className="dues-actions">
      <button type="button" className="ghost" aria-expanded={mode === "upload"} onClick={() => setMode(mode === "upload" ? "none" : "upload")}>{files.length ? "Upload a new version" : "Add the file"}</button>
      <button type="button" className="ghost" aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? "none" : "edit")}>Edit details</button>
      <button type="button" className="ghost danger" aria-expanded={mode === "archive"} onClick={() => setMode(mode === "archive" ? "none" : "archive")}>Archive</button>
    </div>}
    {archived && <div className="dues-actions">
      <button type="button" className="ghost" disabled={busy} onClick={() => void rpc("admin_restore_record", { p_record: record.id }, "Restored.")}>Restore</button>
      <button type="button" className="ghost danger" aria-expanded={mode === "erase"} onClick={() => setMode(mode === "erase" ? "none" : "erase")}>Erase permanently…</button>
    </div>}

    {mode === "upload" && <form className="vault-form" onSubmit={upload}>
      <label className="vault-wide">File <span className="field-caption">PDF or photo, up to 20 MB</span><input name="file" type="file" accept={RECORD_FILE_ACCEPT} required disabled={busy} /></label>
      {files.length > 0 && <label className="vault-wide">What changed in this version?<input name="note" required maxLength={500} placeholder="Renewed for 2027; new premium" disabled={busy} /></label>}
      <p className="dues-note vault-wide">{files.length ? "The current file is not replaced: it stays in the list as an earlier version." : "The file is kept as version 1."}</p>
      <div className="dues-actions vault-wide"><button disabled={busy}>{busy ? "Uploading…" : "Upload"}</button><button type="button" className="ghost" disabled={busy} onClick={() => setMode("none")}>Cancel</button></div>
    </form>}

    {mode === "edit" && <RecordForm record={record} onCancel={() => setMode("none")} setMessage={setMessage} onSaved={async (_id, note) => { setMode("none"); setMessage(note); await reload(); }} />}

    {mode === "archive" && <form className="vault-form" onSubmit={(e) => { e.preventDefault(); void rpc("admin_archive_record", { p_record: record.id, p_reason: String(new FormData(e.currentTarget).get("reason") ?? "") }, "Archived. It is under Archived and can be restored."); }}>
      <label className="vault-wide">Why is it being archived?<input name="reason" required maxLength={500} placeholder="Replaced by the 2027 policy" disabled={busy} /></label>
      <p className="dues-note vault-wide">Archiving moves the record to Archived. Its files and history stay, and it can be restored.</p>
      <div className="dues-actions vault-wide"><button className="danger" disabled={busy}>Archive</button><button type="button" className="ghost" disabled={busy} onClick={() => setMode("none")}>Cancel</button></div>
    </form>}

    {mode === "erase" && (blocker
      ? <p className="dues-flash vault-blocked" role="status">{blocker}</p>
      : <EraseForm record={record} busy={busy} onSubmit={erase} onCancel={() => setMode("none")} />)}

    <details className="vault-history" onToggle={(e) => setHistoryOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>History</summary>
      {historyOpen && <RecordHistory record={record} />}
    </details>
  </div>;
}

function EraseForm({ record, busy, onSubmit, onCancel }: { record: VaultRecord; busy: boolean; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  return <form className="vault-form vault-erase" onSubmit={onSubmit}>
    <p className="vault-wide"><b>This cannot be undone.</b> The record, every version of its file and its change history are deleted. The activity log keeps one line: the title, the category, how many files and your reason.</p>
    <label className="vault-wide">Why is it being erased?<input name="reason" required maxLength={500} placeholder="Past the retention period" disabled={busy} /></label>
    <label className="vault-wide">Type the title to confirm: <b>{record.title}</b><input name="confirm" required autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} /></label>
    <div className="dues-actions vault-wide">
      <button className="danger" disabled={busy || typed.trim() !== record.title}>{busy ? "Erasing…" : "Erase permanently"}</button>
      <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}

type HistoryItem = { key: string; at: string; title: string; detail: string; by: string };

/** Every saved state (from org_record_revisions) and every file added, viewed or downloaded (from the activity log). */
function RecordHistory({ record }: { record: VaultRecord }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const [{ data: revs }, { data: access }] = await Promise.all([
        supabase.from("org_record_revisions").select("id,version,snapshot,change_note,created_at,changer:profiles!org_record_revisions_changed_by_fkey(display_name)").eq("record_id", record.id).order("version"),
        supabase.from("audit_log").select("id,action,detail,created_at,actor_user_id").eq("subject_type", "org_record").eq("subject_id", record.id).like("action", "record_file_%").order("created_at", { ascending: false }).limit(200),
      ]);
      const revisions = (revs ?? []) as unknown as Revision[];
      const accessRows = (access ?? []) as AccessRow[];
      const ids = [...new Set(accessRows.map((r) => r.actor_user_id).filter((id): id is string => !!id))];
      const { data: people } = ids.length ? await supabase.from("profiles").select("id,display_name,email").in("id", ids) : { data: [] };
      const names = new Map((people ?? []).map((p: { id: string; display_name: string | null; email: string | null }) => [p.id, p.display_name || p.email || ""]));
      const list: HistoryItem[] = [
        ...revisions.map((r, i) => {
          const changed = snapshotChanges(i ? revisions[i - 1].snapshot : null, r.snapshot);
          return { key: `rev-${r.id}`, at: r.created_at, title: `Version ${r.version}: ${r.change_note ?? "Changed"}`, detail: changed.length ? `Changed: ${changed.join(", ")}` : "", by: who(r.changer) };
        }),
        ...accessRows.map((a) => ({ key: `log-${a.id}`, at: a.created_at, title: describeRecordEvent(a.action, a.detail), detail: "", by: (a.actor_user_id && names.get(a.actor_user_id)) || "a former administrator" })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      if (live) setItems(list);
    })();
    return () => { live = false; };
  }, [record.id, record.version, record.org_record_files.length]);

  if (!items) return <p className="dues-note">Loading…</p>;
  if (!items.length) return <p className="dues-note">Nothing yet.</p>;
  return <ol className="dues-history-list vault-timeline">
    {items.map((item) => <li key={item.key}><b>{item.title}</b>{item.detail && <> · {item.detail}</>}<small>{when(item.at)} · {item.by}</small></li>)}
  </ol>;
}

/* ---------- Key facts ---------- */

function FactsView({ setMessage }: { setMessage: (m: string) => void }) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_list_org_facts");
    if (error) setMessage(error.message);
    setFacts((data ?? []) as Fact[]);
  }, [setMessage]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open
  useEffect(() => { void load(); }, [load]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const d = new FormData(event.currentTarget);
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_add_org_fact", { p_label: String(d.get("label") ?? ""), p_sensitive: d.get("sensitive") === "on" });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setAdding(false); setMessage("Added. Give it a value below."); await load();
  }

  return <>
    <p className="dues-note">The co-op&rsquo;s own details, kept in one place for forms, renewals and the year-end tax summary. Sensitive values show only their last four characters until revealed.</p>
    {facts === null ? <p className="dues-note">Loading…</p> : <ul className="vault-facts">
      {facts.map((fact) => <FactRow key={fact.key} fact={fact} reload={load} setMessage={setMessage} />)}
    </ul>}
    {adding ? <form className="vault-form dues-setup" onSubmit={add}>
      <h3 className="vault-wide">Add a fact</h3>
      <label className="vault-wide">Name<input name="label" required maxLength={80} placeholder="State charity registration number" disabled={busy} /></label>
      <label className="dues-agree vault-wide"><input name="sensitive" type="checkbox" disabled={busy} /> <span>Sensitive: mask it and log each time it is shown</span></label>
      <div className="dues-actions vault-wide"><button disabled={busy}>Add</button><button type="button" className="ghost" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
    </form> : <div className="dues-actions"><button type="button" className="ghost" onClick={() => setAdding(true)}>Add a fact</button></div>}
  </>;
}

function FactRow({ fact, reload, setMessage }: { fact: Fact; reload: () => Promise<void>; setMessage: (m: string) => void }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [mode, setMode] = useState<"none" | "edit" | "history">("none");
  const [history, setHistory] = useState<FactRevision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function reveal() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setMessage("");
    const { data, error } = await supabase.rpc("admin_reveal_org_fact", { p_key: fact.key });
    if (error) { setMessage(error.message); return; }
    setRevealed((data as string | null) ?? "");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRevealed(null), 60_000);
  }
  function hide() { if (timer.current) clearTimeout(timer.current); setRevealed(null); }

  async function toggleHistory() {
    if (mode === "history") { setMode("none"); return; }
    setMode("history"); setHistory(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_org_fact_history", { p_key: fact.key });
    if (error) { setMessage(error.message); return; }
    setHistory((data ?? []) as FactRevision[]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const d = new FormData(event.currentTarget);
    const value = String(d.get("value") ?? "").trim();
    if (fact.sensitive && !value) { setMessage("Type the full new value."); return; }
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_set_org_fact", { p_key: fact.key, p_value: value || null, p_change_note: String(d.get("why") ?? "").trim() || null });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    hide(); setMode("none"); setMessage(`${fact.label} saved.${fact.version > 0 ? " The earlier value is kept in its history." : ""}`); await reload();
  }

  const shown = revealed ?? fact.value;
  return <li className="vault-fact">
    <div className="vault-fact-main">
      <span className="vault-fact-label">{fact.label}{fact.sensitive && <span className="vault-chip vault-chip-sensitive">Sensitive</span>}</span>
      <span className="vault-fact-value">{shown ? shown : <em>Not set</em>}
        {revealed !== null && <small> Shown for a minute; this was logged. <button type="button" className="vault-link" onClick={hide}>Hide</button></small>}
      </span>
      {fact.updated_at && <small className="dues-note">Changed {when(fact.updated_at)} by {fact.updated_by_name || "a former administrator"}</small>}
    </div>
    <div className="dues-actions">
      {fact.sensitive && fact.has_value && revealed === null && <button type="button" className="ghost" onClick={reveal}>Reveal</button>}
      <button type="button" className="ghost" aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? "none" : "edit")}>Edit</button>
      {fact.version > 0 && <button type="button" className="ghost" aria-expanded={mode === "history"} onClick={toggleHistory}>History</button>}
    </div>
    {mode === "edit" && <form className="vault-form vault-fact-form" onSubmit={save}>
      <label className="vault-wide">{fact.label}
        {fact.key === "address" || fact.key === "landlord_contact" || fact.key === "registered_agent"
          ? <textarea name="value" rows={3} maxLength={2000} defaultValue={fact.sensitive ? "" : fact.value ?? ""} disabled={busy} />
          : <input name="value" maxLength={2000} autoComplete="off" defaultValue={fact.sensitive ? "" : fact.value ?? ""} placeholder={fact.key === "ein" ? "12-3456789" : fact.sensitive ? "Type the full new value" : ""} disabled={busy} />}
      </label>
      {fact.version > 0 && <label className="vault-wide">Why are you changing it?<input name="why" required maxLength={500} disabled={busy} /></label>}
      {fact.sensitive && <p className="dues-note vault-wide">The current value is not filled in here, so it is never shown without a logged reveal.</p>}
      {!fact.sensitive && fact.has_value && <p className="dues-note vault-wide">Leave it empty to clear it.</p>}
      <div className="dues-actions vault-wide"><button disabled={busy}>{busy ? "Saving…" : "Save"}</button><button type="button" className="ghost" disabled={busy} onClick={() => setMode("none")}>Cancel</button></div>
    </form>}
    {mode === "history" && (history === null ? <p className="dues-note">Loading…</p> : <ol className="dues-history-list vault-timeline">
      {history.map((h) => <li key={h.version}><b>v{h.version}</b> {h.value ?? <em>cleared</em>}{h.change_note ? ` · ${h.change_note}` : ""}<small>{when(h.created_at)} · {h.changed_by_name || "a former administrator"}</small></li>)}
      {fact.sensitive && <li className="vault-note-item"><small>Earlier values of a sensitive fact are shown masked.</small></li>}
    </ol>)}
  </li>;
}
