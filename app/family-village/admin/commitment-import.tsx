"use client";

import { useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  ROLES, ROLE_SHORT, importRows, matchName, parseCommitmentSheet,
  type CommitmentData, type Match, type ParsedSheet,
} from "../../../lib/teaching-commitment";

type Sheet = Extract<ParsedSheet, { ok: true }>;

/**
 * Brings this year's spreadsheet into the tracker. The admin saves it as CSV (File, Download, CSV in Google Sheets;
 * Save As, CSV in Excel), uploads it here, checks the preview (each name matched to an account, or kept as a name,
 * or skipped) and chooses which term each Block is. Saving stores the counts as entries that replace the portal's own
 * counts for those terms (public.admin_import_teaching_commitment). Nothing is saved before that.
 */
export default function CommitmentImport({ data, onSaved }: { data: CommitmentData; onSaved: () => Promise<unknown> }) {
  const terms = useMemo(() => data.terms ?? [], [data]);
  const candidates = useMemo(() => data.candidates ?? [], [data]);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.user_id, candidate])), [candidates]);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [problem, setProblem] = useState("");
  const [matches, setMatches] = useState<Record<number, Match>>({});
  const [choice, setChoice] = useState<Record<number, string>>({});
  const [blockTerms, setBlockTerms] = useState<(string | null)[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function read(file: File) {
    setMessage(""); setProblem(""); setSheet(null); setFileName(file.name);
    if (file.size > 1_000_000) { setProblem("That file is larger than a spreadsheet of names should be (over 1 MB)."); return; }
    const parsed = parseCommitmentSheet(await file.text());
    if (!parsed.ok) { setProblem(parsed.error); return; }
    const found: Record<number, Match> = {};
    const picked: Record<number, string> = {};
    for (const row of parsed.rows) {
      found[row.line] = matchName(row.name, candidates);
      // A clear match is chosen; anything else waits for the admin.
      picked[row.line] = found[row.line].userId ?? "";
    }
    setMatches(found); setChoice(picked);
    setBlockTerms(parsed.blocks.map((_, index) => terms[index]?.id ?? null));
    setReason(`Imported from ${file.name}`);
    setSheet(parsed);
  }

  const undecided = sheet ? sheet.rows.filter((row) => !choice[row.line]).length : 0;
  const chosenTerms = blockTerms.filter((id): id is string => !!id);
  const duplicateTerm = new Set(chosenTerms).size !== chosenTerms.length;
  const twice = useMemo(() => {
    const seen = new Map<string, number>();
    for (const value of Object.values(choice)) if (value && value !== "label" && value !== "skip") seen.set(value, (seen.get(value) ?? 0) + 1);
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  }, [choice]);
  const kept = sheet ? sheet.rows.filter((row) => choice[row.line] && choice[row.line] !== "skip").length : 0;

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !sheet || !data.school_year) return;
    const labels = terms.filter((term) => chosenTerms.includes(term.id)).map((term) => term.label).join(", ");
    if (!confirm(`Save the spreadsheet's counts for ${kept} ${kept === 1 ? "person" : "people"}? For ${labels}, they replace the counts the portal works out from assignments. You can remove any entry later.`)) return;
    setBusy(true); setMessage("");
    const { data: result, error } = await supabase.rpc("admin_import_teaching_commitment", {
      p_school_year_id: data.school_year.id, p_term_ids: [...new Set(chosenTerms)], p_rows: importRows(sheet, blockTerms, choice), p_reason: reason,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    const done = result as { people: number; skipped_zero: number; skipped_blank: number; skipped_unknown: number };
    setMessage(`Saved ${done.people} ${done.people === 1 ? "person" : "people"}.${done.skipped_unknown ? ` ${done.skipped_unknown} could not be matched to an active account and were left out.` : ""}`);
    setSheet(null); setFileName("");
    await onSaved();
  }

  return <div className={`record${open ? " open" : ""}`}>
    <button type="button" className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary">Import the spreadsheet</span>
      <span className="record-meta">From a CSV in the co-op&rsquo;s layout</span>
    </button>
    {open && <div className="record-body">
      <p className="field-note">
        Save the teaching commitment spreadsheet as CSV and choose it here. It needs the usual layout: a Name column,
        then Block 1 to Block 4 with Taught, Assisted and Hall Monitor beneath each. Title rows, the totals columns,
        blank rows and rows of zeros are ignored. Nothing is saved until you check the preview.
      </p>
      <div className="portal-form">
        <label className="file-drop"><span className="field-caption">Spreadsheet (CSV)</span>
          <input type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ""; }} />
        </label>
      </div>
      {problem && <p className="admin-form-status import-problem" role="alert">{fileName}: {problem}</p>}

      {sheet && <>
        <p className="compliance-summary"><b>{sheet.rows.length}</b> {sheet.rows.length === 1 ? "person" : "people"} in {fileName}
          {sheet.skipped.length ? `, ${sheet.skipped.length} row${sheet.skipped.length === 1 ? "" : "s"} ignored` : ""}</p>
        {sheet.warnings.map((warning) => <p key={warning} className="field-note">{warning}</p>)}

        <div className="tc-controls">
          {sheet.blocks.map((block, index) => <label key={block.label}><span className="field-caption">{block.label} is</span>
            <select value={blockTerms[index] ?? ""} onChange={(event) => setBlockTerms(blockTerms.map((id, i) => i === index ? (event.target.value || null) : id))}>
              <option value="">Not imported</option>
              {terms.map((term) => <option key={term.id} value={term.id}>{term.label}</option>)}
            </select>
          </label>)}
        </div>
        {duplicateTerm && <p className="admin-form-status import-problem" role="alert">Two blocks are set to the same term.</p>}

        <div className="tc-scroller">
          <table className="compliance-matrix tc-import">
            <thead><tr>
              <th>Line</th><th>In the file</th><th>Portal account</th>
              {sheet.blocks.map((block) => <th key={block.label} className="num">{block.label}<br /><small>{ROLES.map((role) => ROLE_SHORT[role]).join(" / ")}</small></th>)}
              <th className="num">Total</th><th>Notes</th>
            </tr></thead>
            <tbody>
              {sheet.rows.map((row) => {
                const match = matches[row.line];
                const value = choice[row.line] ?? "";
                const suggested = new Set(match?.suggestions ?? []);
                return <tr key={row.line} className={value === "skip" ? "import-skip" : ""}>
                  <td className="num">{row.line}</td>
                  <td><b>{row.name}</b>
                    {match?.confidence === "likely" && value === match.userId && <small className="tc-flag"> Check this match</small>}
                    {row.warnings.map((warning) => <small key={warning} className="tc-flag">{warning}</small>)}
                  </td>
                  <td>
                    <select aria-label={`Portal account for ${row.name}`} value={value} className={value ? "" : "tc-undecided"}
                      onChange={(event) => setChoice({ ...choice, [row.line]: event.target.value })}>
                      <option value="">Choose…</option>
                      <option value="label">Keep as a name only (no account)</option>
                      <option value="skip">Skip this row</option>
                      {suggested.size > 0 && <optgroup label="Likely">
                        {[...suggested].map((id) => <option key={id} value={id}>{byId.get(id)?.name}{byId.get(id)?.household_name ? ` (${byId.get(id)?.household_name})` : ""}</option>)}
                      </optgroup>}
                      <optgroup label="Everyone">
                        {candidates.filter((candidate) => !suggested.has(candidate.user_id)).map((candidate) =>
                          <option key={candidate.user_id} value={candidate.user_id}>{candidate.name}{candidate.household_name ? ` (${candidate.household_name})` : ""}</option>)}
                      </optgroup>
                    </select>
                    {twice.has(value) && <small className="tc-flag">Chosen for two rows</small>}
                  </td>
                  {row.counts.map((counts, index) => <td key={index} className="num">{counts.taught} / {counts.assisted} / {counts.hall_monitor}</td>)}
                  <td className="num">{row.total}</td>
                  <td>{row.note}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        {sheet.skipped.length > 0 && <details className="tc-skipped">
          <summary>Rows ignored ({sheet.skipped.length})</summary>
          <ul>{sheet.skipped.map((row) => <li key={row.line}>Line {row.line}: {row.why === "blank" ? "blank" : row.why === "zero" ? `${row.name}, all zeros` : `${row.name} (a totals row)`}{row.note ? `, note "${row.note}"` : ""}</li>)}</ul>
        </details>}

        <div className="portal-form">
          <label><span className="field-caption">Reason, kept with every entry</span>
            <input value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          </label>
        </div>
        <div className="row-actions">
          <button type="button" disabled={busy || undecided > 0 || !chosenTerms.length || duplicateTerm || !kept || reason.trim().length < 3} onClick={() => void save()}>
            {busy ? "Saving…" : `Save ${kept} ${kept === 1 ? "person" : "people"}`}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => { setSheet(null); setFileName(""); }}>Discard</button>
        </div>
        {undecided > 0 && <p className="field-note">{undecided} {undecided === 1 ? "name needs" : "names need"} a choice: an account, a name only, or skip.</p>}
        {!chosenTerms.length && <p className="field-note">Choose which term at least one block is.</p>}
      </>}
      {message && <p className="admin-form-status" role="status">{message}</p>}
    </div>}
  </div>;
}
