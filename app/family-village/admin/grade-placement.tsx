"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { SchoolYear } from "../../../lib/compliance";

/**
 * Grade-based placement: History and Science classes place children by grade.
 *
 * The database does the placing (admin_place_children_by_grade); this is the
 * button, the year it is for and the report. A preview runs the whole thing and
 * undoes it, so what the report says is what pressing "Place children" does.
 * Anything placed or withdrawn by hand is never touched, and a full class puts a
 * child on the waitlist rather than over the limit.
 */

export type PlacementItem = {
  child_id: string; child: string; family: string; subject: string; grade: string | null;
  outcome: "placed" | "already" | "manual" | "removed" | "waitlisted" | "promoted" | "no_grade" | "no_class" | "clash";
  class?: string | null; from?: string | null; detail?: string | null;
};
export type PlacementReportData = {
  year: string; skipped_not_returning: number; dry_run?: boolean;
  counts: Partial<Record<PlacementItem["outcome"], number>>;
  warnings: { subject: string; kind: string; detail: string }[];
  items: PlacementItem[];
};

function plural(count: number, one: string, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }

const ATTENTION: PlacementItem["outcome"][] = ["no_grade", "no_class", "clash", "waitlisted"];
const TITLES: Record<string, string> = {
  waitlisted: "Waiting for a seat", no_grade: "No grade on file", no_class: "No class for their grade", clash: "Meets at the same time as another class",
};

export function PlacementReport({ report, preview }: { report: PlacementReportData; preview: boolean }) {
  const counts = report.counts;
  const n = (key: PlacementItem["outcome"]) => counts[key] ?? 0;
  const placed = report.items.filter((item) => item.outcome === "placed" || item.outcome === "promoted");
  const kept = report.items.filter((item) => item.outcome === "manual" || item.outcome === "removed");
  const attention = report.items.filter((item) => ATTENTION.includes(item.outcome));
  const line = (item: PlacementItem) => <li key={`${item.child_id}-${item.subject}`}>
    <b>{item.child}</b> <span className="sign-hint">({item.family}{item.grade ? `, grade ${item.grade}` : ""})</span> · {item.subject}
    {item.class ? <> → {item.class}</> : null}
    {item.detail ? <span className="sign-hint"> — {item.detail}</span> : null}
  </li>;

  return <div className="rollover-review placement-report">
    <p className="rollover-headline">
      {preview ? "Would make " : "Made "}{plural(n("placed") + n("promoted"), "placement")}
      {attention.length ? `, ${attention.length} need${attention.length === 1 ? "s" : ""} attention` : ""}
    </p>
    <p className="sign-hint">
      {report.year}. {n("already") ? `${n("already")} already in the right class. ` : ""}
      {n("manual") + n("removed") ? `${n("manual") + n("removed")} left alone because they were placed or withdrawn by hand. ` : ""}
      {report.skipped_not_returning ? `${plural(report.skipped_not_returning, "child", "children")} in households not returning were skipped.` : ""}
    </p>

    {report.warnings.length > 0 && <ul className="placement-warnings">
      {report.warnings.map((warning, index) => <li key={index}><b>{warning.subject}:</b> {warning.detail}</li>)}
    </ul>}

    {ATTENTION.map((key) => {
      const rows = report.items.filter((item) => item.outcome === key);
      return rows.length ? <section key={key}>
        <p className="field-caption">{TITLES[key]} ({rows.length})</p>
        <ul className="placement-list">{rows.map(line)}</ul>
      </section> : null;
    })}

    {placed.length > 0 && <details><summary>{preview ? "Would be placed" : "Placed"} ({placed.length})</summary>
      <ul className="placement-list">{placed.map(line)}</ul></details>}
    {kept.length > 0 && <details><summary>Left alone ({kept.length})</summary>
      <ul className="placement-list">{kept.map(line)}</ul></details>}
    {!report.items.length && <p className="sign-hint">No class is set up to place by grade for {report.year}. Open a class, choose &ldquo;By grade, automatically&rdquo; under Who is placed in it, give it a subject and its grades.</p>}
  </div>;
}

export default function GradePlacement({ years, onSaved, onStatus }: {
  years: SchoolYear[];
  onSaved: () => void;
  onStatus: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState("");
  const [report, setReport] = useState<PlacementReportData | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState("");
  const sorted = [...years].sort((a, b) => b.label.localeCompare(a.label));
  const yearId = chosen || years.find((year) => year.is_current)?.id || sorted[0]?.id || "";
  const year = years.find((entry) => entry.id === yearId);

  async function run(dry: boolean) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !yearId) return;
    if (!dry && !confirm(`Place children in ${year?.label}'s History, Science and other grade-based classes? Anything placed or withdrawn by hand is left as it is.`)) return;
    setBusy(dry ? "preview" : "run"); setError("");
    const { data, error: runError } = await supabase.rpc("admin_place_children_by_grade", { p_year: yearId, p_dry_run: dry });
    setBusy(null);
    if (runError) { setError(runError.message); return; }
    const result = data as PlacementReportData;
    setReport(result);
    if (!dry) {
      const attention = result.items.filter((item) => ATTENTION.includes(item.outcome)).length;
      onStatus(`Placement for ${result.year}: ${plural((result.counts.placed ?? 0) + (result.counts.promoted ?? 0), "placement")} made${attention ? `, ${attention} need attention (see Grade-based placement)` : ""}.`);
      onSaved();
    }
  }

  return <div className="record-section school-years grade-placement">
    <button className="record-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="record-caret" aria-hidden>{open ? "▾" : "▸"}</span>
      <span className="record-summary"><b>Grade-based placement</b></span>
      <span className="record-meta">Place children in History, Science and other grade-assigned classes</span>
    </button>
    {open && <div className="record-body">
      <p className="sign-hint">For every class set to &ldquo;By grade&rdquo;, each child of a returning household is placed in the class of that subject that covers their grade for the year. Run it again any time to correct a birthdate or grade, or to fill seats that have opened. Electives stay with families, and nothing placed or withdrawn by hand is ever changed.</p>
      <label><span className="field-caption">School year</span>
        <select value={yearId} onChange={(event) => { setChosen(event.target.value); setReport(null); }}>
          {sorted.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{entry.is_current ? " (current)" : ""}</option>)}
        </select>
      </label>
      <div className="row-actions">
        <button type="button" className="ghost" disabled={busy !== null || !yearId} onClick={() => run(true)}>{busy === "preview" ? "Checking…" : "Check who would be placed"}</button>
        <button type="button" disabled={busy !== null || !yearId} onClick={() => run(false)}>{busy === "run" ? "Placing…" : "Place children"}</button>
      </div>
      {error && <p className="admin-form-status" role="alert">{error}</p>}
      {report && <PlacementReport report={report} preview={!!report.dry_run} />}
    </div>}
  </div>;
}
