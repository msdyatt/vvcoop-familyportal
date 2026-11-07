"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrl } from "../../../lib/storage";
import { resizeImage } from "../../../lib/image-resize";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { formatCents, formatDueDate, parseDollars } from "../../../lib/dues";

type Category = { id: string; name: string; active: boolean };
type Expense = {
  id: string; spent_on: string; amount_cents: number; category_id: string; vendor: string; note: string | null; version: number;
  voided_at: string | null; void_reason: string | null; created_at: string;
  entered: { display_name: string | null; email: string } | null;
  expense_receipts: { id: string; storage_path: string; file_name: string; removed_at: string | null }[];
};
type Revision = { id: string; version: number; spent_on: string; amount_cents: number; vendor: string; note: string | null; voided: boolean; change_note: string | null; created_at: string };
type Summary = { dues_collected_cents: number; expenses_cents: number; net_cents: number; by_category: { category: string; cents: number }[] };

const EXPENSE_SELECT = "id,spent_on,amount_cents,category_id,vendor,note,version,voided_at,void_reason,created_at,entered:profiles!expenses_entered_by_fkey(display_name,email),expense_receipts(id,storage_path,file_name,removed_at)";
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

/** Photos become JPEGs before upload: the private bucket takes JPEG, PNG, WebP and PDF only. */
async function prepare(file: File): Promise<File> {
  if (file.type === "application/pdf") return file;
  return file.type === "image/png" || file.type === "image/webp" ? file : await resizeImage(file, 2000, 0.85);
}

export default function ExpensesTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ search: "", category: "", from: "", to: "", voided: false });
  const [range, setRange] = useState(() => { const y = new Date().getFullYear(); return { from: `${y}-01-01`, to: `${y}-12-31` }; });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [c, e] = await Promise.all([
      supabase.from("expense_categories").select("id,name,active").order("sort_order"),
      supabase.from("expenses").select(EXPENSE_SELECT).order("spent_on", { ascending: false }).limit(1000),
    ]);
    setCategories((c.data ?? []) as Category[]);
    setExpenses((e.data ?? []) as unknown as Expense[]);
    const { data } = await supabase.rpc("admin_finance_summary", { p_from: range.from, p_to: range.to });
    setSummary((data as Summary | null) ?? null);
  }, [range]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open and when the range changes
  useEffect(() => { void load(); }, [load]);

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const shown = useMemo(() => expenses.filter((x) =>
    (filters.voided || !x.voided_at) && (!filters.category || x.category_id === filters.category) &&
    (!filters.from || x.spent_on >= filters.from) && (!filters.to || x.spent_on <= filters.to) &&
    (!filters.search.trim() || `${x.vendor} ${x.note ?? ""}`.toLowerCase().includes(filters.search.trim().toLowerCase()))), [expenses, filters]);
  const shownTotal = shown.filter((x) => !x.voided_at).reduce((t, x) => t + x.amount_cents, 0);

  async function uploadReceipts(expenseId: string, files: File[]) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    for (const original of files) {
      const file = await prepare(original);
      const safe = original.name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.(heic|heif)$/i, ".jpg");
      const path = `expenses/${expenseId}/${crypto.randomUUID()}-${safe}`;
      const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
      if (error) { setMessage(`${original.name}: ${error.message}`); continue; }
      const { error: recordError } = await supabase.rpc("admin_add_expense_receipt", { p_expense: expenseId, p_path: path, p_file_name: original.name, p_content_type: file.type, p_size_bytes: file.size });
      if (recordError) setMessage(`${original.name}: ${recordError.message}`);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const supabase = getSupabaseBrowserClient();
    const cents = parseDollars(String(data.get("amount") ?? ""));
    if (!supabase || cents === null || cents <= 0) { setMessage("Enter the amount as dollars, for example 125.50."); return; }
    setBusy(true); setMessage("");
    const { data: id, error } = await supabase.rpc("admin_create_expense", {
      p_spent_on: data.get("date"), p_amount_cents: cents, p_category: data.get("category"), p_vendor: data.get("vendor"), p_note: data.get("note") || null,
    });
    if (error) { setBusy(false); setMessage(error.message); return; }
    const files = (data.getAll("receipts") as File[]).filter((f) => f.size > 0);
    await uploadReceipts(id as string, files);
    setBusy(false); form.reset();
    setMessage(files.length ? "Expense recorded with its receipt." : "Expense recorded. Add the receipt when you have it.");
    await load();
  }

  function exportCsv() {
    downloadCsv("expenses.csv", toCsv([["Date", "Vendor", "Category", "Amount", "Note", "Entered by", "Receipts", "Status"],
      ...shown.map((x) => [x.spent_on, x.vendor, categoryName.get(x.category_id) ?? "", x.amount_cents / 100, x.note ?? "", x.entered?.display_name ?? x.entered?.email ?? "Former administrator", x.expense_receipts.filter((r) => !r.removed_at).length, x.voided_at ? `Voided: ${x.void_reason}` : "Recorded"])]));
  }

  return <div className="dues-admin">
    <header className="dues-admin-head"><div><p className="card-kicker">Money</p><h2>Expenses</h2></div></header>
    {message && <p className="dues-flash" role="status">{message}</p>}

    <section className="dues-setup">
      <h3>Money in and out</h3>
      <div className="compliance-toolbar">
        <label>From<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
      </div>
      {summary && <>
        <dl className="dues-totals">
          <div><dt>Dues collected (after refunds)</dt><dd>{formatCents(summary.dues_collected_cents)}</dd></div>
          <div><dt>Spent</dt><dd>{formatCents(summary.expenses_cents)}</dd></div>
          <div><dt>Difference</dt><dd>{formatCents(summary.net_cents)}</dd></div>
        </dl>
        {summary.by_category.length > 0 && <ul className="dues-bycategory">{summary.by_category.map((row) => <li key={row.category}><span>{row.category}</span><b>{formatCents(row.cents)}</b></li>)}</ul>}
      </>}
    </section>

    <form className="dues-setup compliance-form" onSubmit={create}>
      <h3>Record an expense</h3>
      <label>Date<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
      <label>Amount ($)<input name="amount" required inputMode="decimal" placeholder="125.50" /></label>
      <label>Category<select name="category" required defaultValue="">{<option value="" disabled>Choose…</option>}{categories.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Vendor<input name="vendor" required maxLength={120} /></label>
      <label>Note<input name="note" maxLength={1000} /></label>
      <label>Receipt (photo or PDF)<input name="receipts" type="file" accept={ACCEPT} multiple capture="environment" /></label>
      <button disabled={busy}>{busy ? "Saving…" : "Record expense"}</button>
    </form>

    <div className="compliance-toolbar">
      <label>Search<input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Vendor or note" /></label>
      <label>Category<select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">All</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>From<input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
      <label>To<input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
      <label className="dues-agree"><input type="checkbox" checked={filters.voided} onChange={(e) => setFilters({ ...filters, voided: e.target.checked })} /> <span>Show voided</span></label>
      <button type="button" className="ghost" onClick={exportCsv}>Export CSV</button>
    </div>
    <p className="dues-note">{shown.length} expenses · {formatCents(shownTotal)}</p>
    <ul className="dues-ledger">
      {shown.map((x) => <li key={x.id}>
        <button type="button" className="dues-ledger-row" aria-expanded={openId === x.id} onClick={() => setOpenId(openId === x.id ? null : x.id)}>
          <b>{x.vendor}</b><span>{formatDueDate(x.spent_on)} · {categoryName.get(x.category_id)}</span><span>{x.voided_at ? "Voided" : `${x.expense_receipts.filter((r) => !r.removed_at).length} receipt(s)`}</span><span className="dues-amount">{formatCents(x.amount_cents)}</span>
        </button>
        {openId === x.id && <ExpenseDetail expense={x} categories={categories} busy={busy} setBusy={setBusy} setMessage={setMessage} reload={load} upload={uploadReceipts} />}
      </li>)}
    </ul>
    {!shown.length && <p className="portal-empty">No expenses match.</p>}
  </div>;
}

function ExpenseDetail({ expense, categories, busy, setBusy, setMessage, reload, upload }: {
  expense: Expense; categories: Category[]; busy: boolean; setBusy: (b: boolean) => void; setMessage: (m: string) => void;
  reload: () => Promise<void>; upload: (id: string, files: File[]) => Promise<void>;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.from("expense_revisions").select("id,version,spent_on,amount_cents,vendor,note,voided,change_note,created_at").eq("expense_id", expense.id).order("version", { ascending: false });
      if (live) setRevisions((data ?? []) as Revision[]);
    })();
    return () => { live = false; };
  }, [expense.id, expense.version]);

  async function openReceipt(path: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const url = await getSignedFileUrl(supabase, path, 300);
    if (url) window.open(url, "_blank", "noopener,noreferrer"); else setMessage("The receipt could not be opened.");
  }
  async function rpc(fn: string, args: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage(done); setEditing(false); await reload();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const d = new FormData(event.currentTarget);
    const cents = parseDollars(String(d.get("amount") ?? ""));
    if (cents === null || cents <= 0) { setMessage("Enter the amount as dollars."); return; }
    await rpc("admin_update_expense", { p_expense: expense.id, p_spent_on: d.get("date"), p_amount_cents: cents, p_category: d.get("category"), p_vendor: d.get("vendor"), p_note: d.get("note") || null, p_change_note: d.get("why") }, "Saved. The earlier version is kept in the history.");
  }

  return <div className="dues-tools">
    {expense.note && <p className="dues-note">{expense.note}</p>}
    <p className="dues-note">Entered {new Date(expense.created_at).toLocaleDateString("en-US", { timeZone: "America/Chicago" })} by {expense.entered?.display_name ?? expense.entered?.email ?? "a former administrator"}.{expense.voided_at ? ` Voided: ${expense.void_reason}` : ""}</p>
    <ul className="dues-receipts">
      {expense.expense_receipts.map((r) => <li key={r.id}>
        {r.removed_at ? <span className="dues-note">{r.file_name} (removed)</span> : <button type="button" className="link" onClick={() => openReceipt(r.storage_path)}>{r.file_name}</button>}
        {!r.removed_at && !expense.voided_at && <button type="button" className="link" disabled={busy} onClick={() => { const why = prompt("Why remove this receipt? The file is kept in the record."); if (why) void rpc("admin_remove_expense_receipt", { p_receipt: r.id, p_reason: why }, "Receipt removed from view."); }}>Remove</button>}
      </li>)}
    </ul>
    {!expense.voided_at && <div className="dues-actions">
      <label className="compliance-cta ghost">Add a receipt<input type="file" accept={ACCEPT} hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); await upload(expense.id, [f]); setBusy(false); await reload(); }} /></label>
      <button type="button" className="ghost" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
      <button type="button" className="ghost danger" disabled={busy} onClick={() => { const why = prompt("Why void this expense? It stays in the record."); if (why) void rpc("admin_void_expense", { p_expense: expense.id, p_reason: why }, "Voided."); }}>Void</button>
    </div>}
    {editing && <form className="compliance-form" onSubmit={save}>
      <label>Date<input name="date" type="date" required defaultValue={expense.spent_on} /></label>
      <label>Amount ($)<input name="amount" required defaultValue={(expense.amount_cents / 100).toFixed(2)} /></label>
      <label>Category<select name="category" defaultValue={expense.category_id}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label>Vendor<input name="vendor" required defaultValue={expense.vendor} /></label>
      <label>Note<input name="note" defaultValue={expense.note ?? ""} /></label>
      <label>Why are you changing it?<input name="why" required /></label>
      <button disabled={busy}>Save change</button>
    </form>}
    <details><summary>History ({revisions.length})</summary>
      <ol className="dues-history-list">{revisions.map((r) => <li key={r.id}><b>v{r.version}</b> {formatDueDate(r.spent_on)} · {formatCents(r.amount_cents)} · {r.vendor}{r.voided ? " · voided" : ""}<small>{r.change_note} · {new Date(r.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })}</small></li>)}</ol>
    </details>
  </div>;
}
