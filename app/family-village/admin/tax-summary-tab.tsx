"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { useCoopName } from "../../../lib/coop-settings";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { docToRows } from "../../../lib/report-doc";
import { deliverPdf, makePdf } from "../../../lib/report-pdf";
import { parseDollars } from "../../../lib/dues";
import { dollars } from "../../../lib/tax-form-choice";
import {
  E_POSTCARD_SOURCE, FORM_CHOICE_SOURCE, NOT_ADVICE, THREE_YEARS, buildTaxSummaryDoc, ePostcardChecklist, formChoiceFor, formYear, periodLabel,
  type TaxSummary,
} from "../../../lib/tax-summary-doc";

const KINDS = [["donation", "Donation"], ["fundraiser", "Fundraiser"], ["grant", "Grant"], ["other", "Other"]] as const;

function cents(text: string): number | null {
  if (!text.trim()) return null;
  const value = parseDollars(text);
  return value === null || value < 0 ? NaN : value;
}

export default function TaxSummaryTab() {
  const coopName = useCoopName();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear - 1);
  const [summary, setSummary] = useState<TaxSummary | null>(null);
  const [ein, setEin] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_tax_summary", { p_year: year });
    if (error) { setMessage(error.message); setSummary(null); return; }
    setSummary(data as TaxSummary);
  }, [year]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open and when the year changes
  useEffect(() => { void load(); }, [load]);

  const choice = useMemo(() => (summary ? formChoiceFor(summary) : null), [summary]);
  const checklist = useMemo(() => (summary && choice ? ePostcardChecklist(summary, choice) : []), [summary, choice]);
  const filename = `tax-summary-${year}`;

  async function rpc(fn: string, args: Record<string, unknown>, done: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return false;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { setMessage(error.message); return false; }
    setMessage(done); await load();
    return true;
  }

  async function revealEin() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_reveal_org_fact", { p_key: "ein" });
    if (error) { setMessage(error.message); return; }
    setEin((data as string | null) ?? null);
    setTimeout(() => setEin(null), 60_000);
  }

  async function addIncome(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const amount = parseDollars(String(form.get("amount") ?? ""));
    if (amount === null || amount <= 0) { setMessage("Enter the amount as dollars."); return; }
    const ok = await rpc("admin_add_other_income", {
      p_received_on: form.get("date"), p_amount_cents: amount, p_kind: form.get("kind"), p_description: form.get("description"), p_note: form.get("note") || null,
    }, "Added.");
    if (ok) formEl.reset();
  }

  async function saveInputs(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary) return;
    const form = new FormData(event.currentTarget);
    const assets = cents(String(form.get("assets") ?? ""));
    if (Number.isNaN(assets)) { setMessage("Enter total assets as dollars."); return; }
    for (const row of summary.years) {
      const override = cents(String(form.get(`override-${row.year}`) ?? ""));
      if (Number.isNaN(override)) { setMessage(`Enter ${row.year} gross receipts as dollars.`); return; }
      const assetsForYear = row.year === summary.tax_year ? assets : undefined;
      if (override !== row.override_cents || assetsForYear !== undefined) {
        const supabase = getSupabaseBrowserClient();
        if (!supabase) return;
        // Keep the other column for that year as it is.
        const { data: current } = await supabase.from("tax_year_inputs").select("total_assets_cents").eq("year_end", row.last_day).maybeSingle();
        const { error } = await supabase.rpc("admin_set_tax_year_inputs", {
          p_year: row.year, p_gross_receipts_override_cents: override,
          p_total_assets_cents: assetsForYear !== undefined ? assetsForYear : (current?.total_assets_cents ?? null), p_note: null,
        });
        if (error) { setMessage(error.message); return; }
      }
    }
    const formed = String(form.get("formed") ?? "").trim();
    if (formed !== (summary.facts.year_formed?.value ?? "")) {
      if (formed && !/^\d{4}$/.test(formed)) { setMessage("Enter the first tax year as four digits, for example 2023."); return; }
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase!.rpc("admin_set_org_fact", { p_key: "year_formed", p_value: formed || null, p_change_note: "Set from the year-end tax summary" });
      if (error) { setMessage(error.message); return; }
    }
    setMessage("Saved."); await load();
  }

  async function pdf() {
    if (!summary) return;
    setBusy(true); setMessage("Preparing the PDF…");
    try {
      const delivery = await deliverPdf(await makePdf(buildTaxSummaryDoc(summary, coopName)), `${filename}.pdf`);
      setMessage(delivery === "shared" ? "" : delivery === "opened" ? "Opened the PDF." : "Saved the PDF.");
    } catch {
      setMessage("The PDF could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="tax-summary">
    <div className="deadlines-head">
      <div>
        <h2>Year-end tax summary</h2>
        <p className="dues-note">The figures the IRS annual return asks about, from the portal&rsquo;s own records, for the co-op&rsquo;s bookkeeper or tax professional.</p>
      </div>
      <label>Tax year ending in<select value={year} onChange={(e) => setYear(Number(e.target.value))}>
        {[thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}
      </select></label>
    </div>
    <p className="tax-not-advice" role="note"><b>A helper, not tax advice.</b> {NOT_ADVICE}</p>
    {message && <p className="dues-note" role="status">{message}</p>}

    {summary && choice && <>
      <p className="dues-note">{periodLabel(summary)}. On the IRS forms this is the {formYear(summary)} tax year. The fiscal year end comes from Admin, Compliance, Settings.</p>
      {summary.billing_test_mode && <p className="tax-test-mode">Billing is in test mode, so these figures include Stripe test payments.</p>}

      <section className="tax-card" aria-labelledby="tax-figures">
        <h3 id="tax-figures">Money in and out</h3>
        <dl className="tax-figures">
          <dt>Dues collected online (Stripe)</dt><dd>{dollars(summary.dues_online_cents)}</dd>
          <dt>Dues collected offline (cash, check, Crowded)</dt><dd>{dollars(summary.dues_offline_cents)}</dd>
          <dt>Other income (below)</dt><dd>{dollars(summary.other_income_cents)}</dd>
          <dt className="total">Gross receipts</dt><dd className="total">{dollars(summary.gross_receipts_cents)}</dd>
          <dt>Refunds</dt><dd>{dollars(-summary.refunds_cents)}</dd>
          <dt>Expenses</dt><dd>{dollars(-summary.expenses_cents)}</dd>
          <dt className="total">Net</dt><dd className="total">{dollars(summary.net_cents)}</dd>
        </dl>
        <p className="dues-note">Gross receipts are everything received, before refunds and costs, as the IRS counts them. Refunds are shown separately; ask the tax professional whether to subtract them. Stripe&rsquo;s fees are only included if they were entered as expenses.</p>
        {summary.expenses.length > 0 && <table className="tax-table"><caption>Expenses by category</caption>
          <thead><tr><th>Category</th><th>Entries</th><th>Amount</th></tr></thead>
          <tbody>{summary.expenses.map((row) => <tr key={row.category}><td>{row.category}</td><td>{row.count}</td><td>{dollars(row.cents)}</td></tr>)}</tbody>
        </table>}
      </section>

      <section className="tax-card" aria-labelledby="tax-other">
        <h3 id="tax-other">Other income</h3>
        <p className="dues-note">Donations, fundraisers and grants that did not come through dues. Add each one as it arrives so the year-end figure is complete.</p>
        <ul className="tax-income-list">{summary.other_income.map((row) => <li key={row.id}>
          <span>{row.received_on}</span><span>{KINDS.find(([k]) => k === row.kind)?.[1] ?? row.kind}</span><b>{row.description}</b><span>{dollars(row.amount_cents)}</span>
          <button type="button" className="link" disabled={busy} onClick={() => { const why = prompt("Why void this entry? It stays in the record."); if (why) void rpc("admin_void_other_income", { p_id: row.id, p_reason: why }, "Voided."); }}>Void</button>
        </li>)}</ul>
        {!summary.other_income.length && <p className="portal-empty">None entered for this year.</p>}
        <form className="compliance-form tax-inline-form" onSubmit={addIncome}>
          <label>Date<input name="date" type="date" required min={summary.first_day} max={summary.last_day} /></label>
          <label>Kind<select name="kind" defaultValue="donation">{KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
          <label>What it was<input name="description" required maxLength={200} placeholder="Spring bake sale" /></label>
          <label>Amount ($)<input name="amount" required inputMode="decimal" /></label>
          <label>Note<input name="note" maxLength={1000} /></label>
          <button disabled={busy}>Add income</button>
        </form>
      </section>

      <section className="tax-card" aria-labelledby="tax-form">
        <h3 id="tax-form">Which return probably applies: <span className="tax-form-name">Form {choice.form}</span></h3>
        <ol className="tax-steps">{choice.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        {choice.cautions.length > 0 && <ul className="tax-cautions">{choice.cautions.map((c) => <li key={c}>Check: {c}</li>)}</ul>}
        <p className="tax-not-advice">This is guidance. The IRS rules decide, and a tax professional should confirm it. <a href={FORM_CHOICE_SOURCE} target="_blank" rel="noopener noreferrer">IRS: which form to file</a></p>
        <form className="compliance-form tax-inputs" onSubmit={saveInputs}>
          <p className="dues-note">Figures the portal cannot know. Years before the portal can be filled in from bank statements.</p>
          {summary.years.map((row) => <label key={row.year}>{row.year} gross receipts, entered by hand{row.has_portal_records ? ` (portal: ${dollars(row.portal_cents)})` : " (no portal records)"}
            <input name={`override-${row.year}`} inputMode="decimal" defaultValue={row.override_cents === null ? "" : (row.override_cents / 100).toFixed(2)} placeholder="Leave blank to use the portal figure" /></label>)}
          <label>Total assets at the end of {summary.tax_year} (bank balances and anything the co-op owns)<input name="assets" inputMode="decimal" defaultValue={summary.total_assets_cents === null ? "" : (summary.total_assets_cents / 100).toFixed(2)} /></label>
          <label>The co-op&rsquo;s first tax year<input name="formed" inputMode="numeric" maxLength={4} defaultValue={summary.facts.year_formed?.value ?? ""} placeholder="e.g. 2023" /></label>
          <button disabled={busy}>Save figures</button>
        </form>
      </section>

      <section className="tax-card" aria-labelledby="tax-checklist">
        <h3 id="tax-checklist">Form 990-N (e-Postcard) checklist</h3>
        <p className="dues-note">What the e-Postcard asks for, filled in from the records vault and settings. Missing items are flagged; add them as key facts in the records vault. <a href={E_POSTCARD_SOURCE} target="_blank" rel="noopener noreferrer">IRS: information needed</a></p>
        <ul className="tax-checklist">{checklist.map((item) => <li key={item.label} className={item.ok ? "ok" : "missing"}>
          <span className="tax-check-mark" aria-hidden="true">{item.ok ? "✓" : "!"}</span>
          <span><b>{item.label}</b>{item.optional ? " (if it applies)" : ""}<br />
            {item.label === "EIN" && ein ? <span>{ein} <small>(shown for a minute; the reveal was logged)</small></span> : item.value}
            {item.label === "EIN" && !ein && summary.facts.ein?.has_value && <> <button type="button" className="link" onClick={revealEin}>Reveal</button></>}
          </span>
          <span className="tax-check-state">{item.ok ? (item.note ?? "Ready") : "Missing"}</span>
        </li>)}</ul>
      </section>

      <KeyFactsEditor summary={summary} busy={busy} setBusy={setBusy} setMessage={setMessage} reload={load} />

      <section className="tax-card" aria-labelledby="tax-payees">
        <h3 id="tax-payees">Payees who may need a Form 1099-NEC</h3>
        <p className="dues-note">From the payee on each expense in calendar year {summary.tax_year}: everyone paid {dollars(summary.nec_threshold_cents)} or more in total.{summary.nec_threshold_certain ? "" : " After 2026 the IRS adjusts this amount for inflation; check the current instructions."}</p>
        {summary.payees.length ? <table className="tax-table"><thead><tr><th>Payee</th><th>Categories</th><th>Payments</th><th>Total</th></tr></thead>
          <tbody>{summary.payees.map((row) => <tr key={row.payee}><td>{row.payee}</td><td>{row.categories.join(", ")}</td><td>{row.count}</td><td>{dollars(row.cents)}</td></tr>)}</tbody>
        </table> : <p className="portal-empty">No payee reached the threshold this year.</p>}
        <p className="dues-note">Not everyone on this list needs a 1099-NEC: it is for payments for services to a person or an unincorporated business (not employees, and usually not corporations), and payments made by card or a payment app are reported by the payment company instead. The expense records only hold the payee&rsquo;s name. Going forward, for each contractor keep a Form W-9 in the records vault (legal name, address, taxpayer ID, business type) and note how they were paid.</p>
      </section>

      <p className="deadlines-why">{THREE_YEARS} The Compliance calendar reminds administrators before each return is due.</p>
      <div className="report-actions">
        <button type="button" disabled={busy} onClick={pdf}>Download PDF</button>
        <button type="button" className="ghost" onClick={() => downloadCsv(`${filename}.csv`, toCsv(docToRows(buildTaxSummaryDoc(summary, coopName))))}>Export CSV</button>
        <span className="dues-note">The export shows the EIN masked.</span>
      </div>
    </>}
  </div>;
}

const FACT_FIELDS: { key: string; label: string; placeholder?: string }[] = [
  { key: "legal_name", label: "Legal name (exactly as on the IRS letter)" },
  { key: "ein", label: "EIN", placeholder: "12-3456789" },
  { key: "address", label: "Mailing address" },
  { key: "website", label: "Website", placeholder: "https://" },
  { key: "principal_officer_name", label: "Principal officer's name" },
  { key: "principal_officer_address", label: "Principal officer's address" },
];

/**
 * The records vault has no screens yet, so the 990-N facts can be filled in here. Each change goes
 * through the vault's own admin_set_org_fact (kept in its history and the audit log). The EIN is
 * write-only here: the field starts empty and the stored value stays masked.
 */
function KeyFactsEditor({ summary, busy, setBusy, setMessage, reload }: {
  summary: TaxSummary; busy: boolean; setBusy: (b: boolean) => void; setMessage: (m: string) => void; reload: () => Promise<void>;
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const why = String(form.get("why") ?? "").trim();
    setBusy(true); setMessage("");
    let changed = 0;
    for (const field of FACT_FIELDS) {
      const next = String(form.get(field.key) ?? "").trim();
      const fact = summary.facts[field.key];
      const current = field.key === "ein" ? null : (fact?.value ?? "");
      if (field.key === "ein" ? next === "" : next === current) continue;
      const { error } = await supabase.rpc("admin_set_org_fact", { p_key: field.key, p_value: next || null, p_change_note: why || "Set from the year-end tax summary" });
      if (error) { setBusy(false); setMessage(`${field.label}: ${error.message}`); return; }
      changed += 1;
    }
    setBusy(false);
    setMessage(changed ? `Saved ${changed} key fact${changed === 1 ? "" : "s"} to the records vault.` : "Nothing changed.");
    if (changed) await reload();
  }
  return <details className="tax-card tax-facts">
    <summary>Fill in the key facts</summary>
    <form className="compliance-form" onSubmit={save}>
      <p className="dues-note">These are kept in the records vault with a history of every change. The EIN field starts empty: type it only to set or correct it.</p>
      {FACT_FIELDS.map((field) => <label key={field.key}>{field.label}{field.key === "ein" && summary.facts.ein?.has_value ? ` (on file: ${summary.facts.ein.value})` : ""}
        <input name={field.key} maxLength={2000} placeholder={field.placeholder} autoComplete="off" defaultValue={field.key === "ein" ? "" : (summary.facts[field.key]?.value ?? "")} /></label>)}
      <label>Why the change (needed when correcting a fact already on file)<input name="why" maxLength={500} /></label>
      <button disabled={busy}>Save key facts</button>
    </form>
  </details>;
}
