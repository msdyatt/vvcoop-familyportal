"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { FamilyRequirement, Requirement, formatMoney } from "../../../lib/compliance";

type FamilyLite = { id: string; name: string; emails: string[] };

type ParsedRow = {
  line: number;
  rawName: string;
  rawEmail: string;
  amount: number;
  reference: string | null;
  paidOn: string | null;
  familyId: string | null;
  note: string;
};

/**
 * Reads a payments export and marks families paid.
 *
 * Crowded's export format is unconfirmed, so the parser matches on header
 * *names* rather than column positions and accepts the obvious synonyms. A file
 * that does not match reports which headers it did find instead of failing
 * silently -- getting a payment record wrong is worse than refusing the file.
 *
 * Nothing is written until the preview has been reviewed and confirmed.
 */
const NAME_KEYS = ["family", "family name", "household", "name", "payer", "customer", "from"];
const EMAIL_KEYS = ["email", "email address", "payer email"];
const AMOUNT_KEYS = ["amount", "total", "paid", "payment", "amount paid"];
const REF_KEYS = ["reference", "ref", "transaction", "transaction id", "id", "invoice"];
const DATE_KEYS = ["date", "paid on", "paid at", "created", "timestamp"];

/** Minimal CSV reader: handles quoted fields and embedded commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((entry) => entry.some((value) => value.trim()));
}

function findColumn(headers: string[], candidates: string[]): number {
  return headers.findIndex((header) => candidates.includes(header.trim().toLowerCase()));
}

function money(raw: string): number {
  return Number(raw.replace(/[^0-9.-]/g, "")) || 0;
}

/**
 * Matches a payment row to a household.
 *
 * Crowded's export lists whichever *person* paid -- "Raven Monaco" -- not a
 * household name, so matching against families.display_name alone missed
 * almost every row on a real export. Email is the reliable link: any adult in
 * the household, matched exactly, case-insensitive. The name-based match is
 * kept as a fallback for exports that carry a household or payer name instead.
 */
function matchFamily(rawEmail: string, rawName: string, families: FamilyLite[]): string | null {
  const email = rawEmail.trim().toLowerCase();
  if (email) {
    const byEmail = families.find((family) => family.emails.some((candidate) => candidate.toLowerCase() === email));
    if (byEmail) return byEmail.id;
  }
  const value = rawName.trim().toLowerCase();
  if (!value) return null;
  const exact = families.find((family) => family.name.toLowerCase() === value);
  if (exact) return exact.id;
  const contained = families.filter((family) => family.name && value.includes(family.name.toLowerCase()));
  return contained.length === 1 ? contained[0].id : null;
}

export default function DuesImport({ families, rows, requirements, actorUserId, onSaved, onStatus }: {
  families: FamilyLite[];
  rows: FamilyRequirement[];
  requirements: Requirement[];
  actorUserId: string;
  onSaved: () => void;
  onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [problem, setProblem] = useState("");
  const [requirementId, setRequirementId] = useState("");
  const [busy, setBusy] = useState(false);

  const duesRequirements = requirements.filter((requirement) => requirement.kind === "dues");

  async function readFile(file: File) {
    setProblem(""); setParsed(null);
    const table = parseCsv(await file.text());
    if (table.length < 2) { setProblem("That file has no rows under its header."); return; }

    const headers = table[0].map((header) => header.trim());
    const lower = headers.map((header) => header.toLowerCase());
    const nameCol = findColumn(lower, NAME_KEYS);
    const emailCol = findColumn(lower, EMAIL_KEYS);
    const amountCol = findColumn(lower, AMOUNT_KEYS);

    if ((nameCol === -1 && emailCol === -1) || amountCol === -1) {
      setProblem(
        `Could not find a payer name or email column and an amount column. Found: ${headers.join(", ") || "nothing"}. ` +
        `Expected a name or email column and one of ${AMOUNT_KEYS.join(" / ")}.`,
      );
      return;
    }

    const refCol = findColumn(lower, REF_KEYS);
    const dateCol = findColumn(lower, DATE_KEYS);
    setParsed(table.slice(1).map((cells, index) => {
      const rawName = nameCol >= 0 ? (cells[nameCol] ?? "").trim() : "";
      const rawEmail = emailCol >= 0 ? (cells[emailCol] ?? "").trim() : "";
      const familyId = matchFamily(rawEmail, rawName, families);
      const amount = money(cells[amountCol] ?? "");
      return {
        line: index + 2,
        rawName,
        rawEmail,
        amount,
        reference: refCol >= 0 ? (cells[refCol] ?? "").trim() || null : null,
        paidOn: dateCol >= 0 ? (cells[dateCol] ?? "").trim() || null : null,
        familyId,
        note: !familyId ? "No matching household" : amount <= 0 ? "Amount is zero" : "",
      };
    }));
  }

  async function apply() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !parsed || !requirementId) return;
    const usable = parsed.filter((row): row is ParsedRow & { familyId: string } => !!row.familyId && row.amount > 0);
    if (!usable.length) { onStatus("Nothing in that file could be matched to a household."); return; }
    const grouped = new Map<string, typeof usable>();
    usable.forEach((row) => grouped.set(row.familyId, [...(grouped.get(row.familyId) ?? []), row]));
    setBusy(true);

    const results = await Promise.all([...grouped].map(([familyId, payments]) => {
      const existing = rows.find((entry) => entry.requirement_id === requirementId && entry.family_id === familyId);
      const paidOn = payments.map((row) => row.paidOn).find((value) => value && !Number.isNaN(new Date(value).getTime()));
      const payload = {
        status: "complete",
        amount_paid: payments.reduce((total, row) => total + row.amount, 0),
        paid_at: paidOn ? new Date(paidOn).toISOString() : new Date().toISOString(),
        payment_method: "Crowded",
        payment_reference: payments.map((row) => row.reference).filter(Boolean).join(", ") || null,
        updated_by: actorUserId,
      };
      return existing
        ? supabase.from("family_requirements").update(payload).eq("id", existing.id)
        : supabase.from("family_requirements").insert({ requirement_id: requirementId, family_id: familyId, ...payload });
    }));
    const applied = results.filter((result) => !result.error).length;

    setBusy(false);
    setParsed(null);
    onStatus(`Recorded payments for ${applied} famil${applied === 1 ? "y" : "ies"} from the file.`);
    await onSaved();
  }

  const matched = parsed?.filter((row) => row.familyId && row.amount > 0).length ?? 0;
  const matchedFamilies = new Set(parsed?.filter((row) => row.familyId && row.amount > 0).map((row) => row.familyId) ?? []).size;
  const skipped = (parsed?.length ?? 0) - matched;

  function matchRow(line: number, familyId: string) {
    setParsed((rows) => rows?.map((row) => row.line === line ? {
      ...row,
      familyId: familyId || null,
      note: !familyId ? "No matching household" : row.amount <= 0 ? "Amount is zero" : "",
    } : row) ?? null);
  }

  return <div className="record-section school-years">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Import payments</b></span>
      <span className="record-meta">Upload a CSV from Crowded</span>
    </button>

    {open && <div className="record-body">
      <p className="field-note">
        Export payments from Crowded as CSV and upload it here. Columns are matched by their headers, so the order
        does not matter — it needs a household or payer name and an amount, and will use a reference and a date if
        they are there. Nothing is recorded until you review the preview.
      </p>

      <div className="portal-form">
        <label><span className="field-caption">Apply to</span>
          <select value={requirementId} onChange={(event) => setRequirementId(event.target.value)}>
            <option value="">Choose a dues requirement…</option>
            {duesRequirements.map((requirement) => <option key={requirement.id} value={requirement.id}>{requirement.title}</option>)}
          </select>
        </label>
        <label className="file-drop"><span className="field-caption">Payments CSV</span>
          <input type="file" accept=".csv,text/csv" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readFile(file);
          }} />
        </label>
      </div>

      {problem && <p className="admin-form-status import-problem" role="status">{problem}</p>}

      {parsed && <>
        <p className="compliance-summary">
          <b>{matched}</b> row{matched === 1 ? "" : "s"} ready{skipped ? `, ${skipped} skipped` : ""}
        </p>
        <div className="scroller">
          <table className="compliance-matrix">
            <thead><tr><th>Line</th><th>In the file</th><th>Household</th><th className="num">Amount</th><th>Note</th></tr></thead>
            <tbody>
              {parsed.map((row) => <tr key={row.line} className={row.note ? "import-skip" : ""}>
                <td className="num">{row.line}</td>
                <td><span className="import-payer"><b>{row.rawName || "No payer name"}</b>{row.rawEmail ? <small>{row.rawEmail}</small> : null}</span></td>
                <td><select aria-label={`Household for line ${row.line}`} value={row.familyId ?? ""} onChange={(event) => matchRow(row.line, event.target.value)}>
                  <option value="">Unmatched</option>
                  {families.map((family) => <option key={family.id} value={family.id}>{family.name}</option>)}
                </select></td>
                <td className="num">{formatMoney(row.amount)}</td>
                <td>{row.note || "Will be recorded"}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="row-actions">
          <button disabled={busy || !requirementId || !matched} onClick={apply}>
            {busy ? "Recording…" : `Record payments for ${matchedFamilies} famil${matchedFamilies === 1 ? "y" : "ies"}`}
          </button>
          <button className="ghost" disabled={busy} onClick={() => setParsed(null)}>Discard</button>
        </div>
        {!requirementId && <p className="field-note">Choose which dues requirement these payments settle first.</p>}
      </>}
    </div>}
  </div>;
}
