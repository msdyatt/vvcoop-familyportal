"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { FamilyRequirement, Requirement, formatMoney } from "../../../lib/compliance";

type FamilyLite = { id: string; name: string };

type ParsedRow = {
  line: number;
  rawName: string;
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

/** Loose match: exact, then case-insensitive, then "the Lewis family" contains "Lewis". */
function matchFamily(raw: string, families: FamilyLite[]): string | null {
  const value = raw.trim().toLowerCase();
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
    const amountCol = findColumn(lower, AMOUNT_KEYS);

    if (nameCol === -1 || amountCol === -1) {
      setProblem(
        `Could not find a family column and an amount column. Found: ${headers.join(", ") || "nothing"}. ` +
        `Expected one of ${NAME_KEYS.join(" / ")} and one of ${AMOUNT_KEYS.join(" / ")}.`,
      );
      return;
    }

    const refCol = findColumn(lower, REF_KEYS);
    const dateCol = findColumn(lower, DATE_KEYS);

    setParsed(table.slice(1).map((cells, index) => {
      const rawName = (cells[nameCol] ?? "").trim();
      const familyId = matchFamily(rawName, families);
      const amount = money(cells[amountCol] ?? "");
      return {
        line: index + 2,
        rawName,
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
    const usable = parsed.filter((row) => row.familyId && row.amount > 0);
    if (!usable.length) { onStatus("Nothing in that file could be matched to a household."); return; }
    setBusy(true);

    let applied = 0;
    for (const row of usable) {
      const existing = rows.find((entry) => entry.requirement_id === requirementId && entry.family_id === row.familyId);
      const payload = {
        status: "complete",
        amount_paid: row.amount,
        paid_at: row.paidOn ? new Date(row.paidOn).toISOString() : new Date().toISOString(),
        payment_method: "Crowded",
        payment_reference: row.reference,
        updated_by: actorUserId,
      };
      const result = existing
        ? await supabase.from("family_requirements").update(payload).eq("id", existing.id)
        : await supabase.from("family_requirements").insert({ requirement_id: requirementId, family_id: row.familyId, ...payload });
      if (!result.error) applied += 1;
    }

    setBusy(false);
    setParsed(null);
    onStatus(`Recorded ${applied} payment${applied === 1 ? "" : "s"} from the file.`);
    await onSaved();
  }

  const matched = parsed?.filter((row) => row.familyId && row.amount > 0).length ?? 0;
  const skipped = (parsed?.length ?? 0) - matched;

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
                <td>{row.rawName || <em>blank</em>}</td>
                <td>{row.familyId ? families.find((family) => family.id === row.familyId)?.name : <em>unmatched</em>}</td>
                <td className="num">{formatMoney(row.amount)}</td>
                <td>{row.note || "Will be recorded"}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="row-actions">
          <button disabled={busy || !requirementId || !matched} onClick={apply}>
            {busy ? "Recording…" : `Record ${matched} payment${matched === 1 ? "" : "s"}`}
          </button>
          <button className="ghost" disabled={busy} onClick={() => setParsed(null)}>Discard</button>
        </div>
        {!requirementId && <p className="field-note">Choose which dues requirement these payments settle first.</p>}
      </>}
    </div>}
  </div>;
}
