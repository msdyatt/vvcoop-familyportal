"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { docToRows } from "../../../lib/report-doc";
import { deliverPdf, makePdf } from "../../../lib/report-pdf";
import {
  ROLES, ROLE_LABEL, ROLE_SHORT, buildCommitmentDoc, cellOf, coveredText, isAdjusted, shortfall,
  type CommitmentData, type CommitmentHousehold, type CommitmentPerson, type CommitmentRole, type CommitmentTerm,
} from "../../../lib/teaching-commitment";
import DetailModal from "../detail-modal";
import CommitmentImport from "./commitment-import";
import { CommitmentSettingsCard, HallMonitorsCard } from "./commitment-setup";

/**
 * Admin, Classes, Teaching commitment (issue #151): who taught, assisted or was hall monitor in each term, per adult
 * and per household, against the handbook's expectation. Replaces the admins' spreadsheet. The numbers come from
 * public.admin_teaching_commitment; this screen only shows and changes them.
 */

type View = "household" | "everyone";
type Show = "all" | "short" | "heavy";
type Sort = "most" | "fewest" | "name";
type Editing = { person: CommitmentPerson; term: CommitmentTerm; role: CommitmentRole };

export async function loadCommitment(yearId: string | null): Promise<CommitmentData> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error("The portal is not connected.");
  const { data, error } = await supabase.rpc("admin_teaching_commitment", { p_school_year_id: yearId });
  if (error) throw new Error(error.message);
  return data as CommitmentData;
}

export default function CommitmentTab() {
  const [yearId, setYearId] = useState<string | null>(null);
  const [data, setData] = useState<CommitmentData | null>(null);
  const [problem, setProblem] = useState("");
  const [view, setView] = useState<View>("household");
  const [show, setShow] = useState<Show>("all");
  const [sort, setSort] = useState<Sort>("most");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [personOpen, setPersonOpen] = useState<CommitmentPerson | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const next = await loadCommitment(yearId);
      setData(next);
      setProblem("");
      return next;
    } catch (error) {
      setProblem((error as Error).message || "The tracker could not be loaded. Try again in a moment.");
      return null;
    }
  }, [yearId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the chosen year changes
  useEffect(() => { void reload(); }, [reload]);

  const terms = useMemo(() => data?.terms ?? [], [data]);
  const settings = data?.settings;
  const people = useMemo(() => data?.people ?? [], [data]);
  const households = useMemo(() => data?.households ?? [], [data]);
  const householdById = useMemo(() => new Map(households.map((household) => [household.id, household])), [households]);

  const order = useCallback(<T extends { total_roles: number; name: string }>(rows: T[]) => [...rows].sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name)
      : sort === "fewest" ? a.total_roles - b.total_roles || a.name.localeCompare(b.name)
        : b.total_roles - a.total_roles || a.name.localeCompare(b.name)), [sort]);

  const needle = search.trim().toLowerCase();
  const visiblePeople = useMemo(() => order(people.filter((person) => {
    if (needle && !`${person.name} ${person.household_name ?? ""}`.toLowerCase().includes(needle)) return false;
    if (show === "heavy") return person.heavy;
    if (show === "short") {
      const household = person.household_id ? householdById.get(person.household_id) : null;
      return !!household && !household.meets;
    }
    return true;
  })), [people, needle, show, householdById, order]);

  const visibleHouseholds = useMemo(() => order(households.filter((household) => {
    if (show === "short" && household.meets) return false;
    if (show === "heavy" && !people.some((person) => person.household_id === household.id && person.heavy)) return false;
    if (needle && !household.name.toLowerCase().includes(needle)
      && !people.some((person) => person.household_id === household.id && person.name.toLowerCase().includes(needle))) return false;
    return true;
  })), [households, people, show, needle, order]);

  const loose = useMemo(() => visiblePeople.filter((person) => !person.household_id || !householdById.has(person.household_id)),
    [visiblePeople, householdById]);

  if (problem && !data) return <section className="tc-tab"><p className="admin-form-status" role="alert">{problem}</p></section>;
  if (!data || !settings) return <section className="tc-tab"><p className="portal-empty" role="status">Loading the teaching commitment…</p></section>;

  const shortCount = households.filter((household) => !household.meets).length;
  const heavyCount = people.filter((person) => person.heavy).length;

  async function exportAs(kind: "pdf" | "csv") {
    if (!data) return;
    const doc = buildCommitmentDoc({ ...data, households: visibleHouseholds }, { byHousehold: view === "household", people: visiblePeople });
    const filename = `teaching-commitment-${(data.school_year?.label ?? "year").replace(/[^a-z0-9]+/gi, "-")}-${new Date().toISOString().slice(0, 10)}`;
    if (kind === "csv") { downloadCsv(`${filename}.csv`, toCsv(docToRows(doc))); return; }
    setBusy(true); setStatus("Preparing the PDF…");
    try {
      const delivery = await deliverPdf(await makePdf(doc), `${filename}.pdf`);
      setStatus(delivery === "shared" ? "" : delivery === "opened" ? "Opened the PDF." : "Saved the PDF.");
    } catch {
      setStatus("The PDF could not be made. Try again.");
    } finally { setBusy(false); }
  }

  const columnCount = 1 + terms.length * 3 + 5 + 1;
  const editCell = (person: CommitmentPerson, term: CommitmentTerm, role: CommitmentRole) => setEditing({ person, term, role });

  return <section className="tc-tab">
    <div className="section-heading">
      <div><p className="card-kicker">Teaching commitment</p><h2>Who teaches, assists and monitors.</h2></div>
      <p>
        Every household teaches {settings.teach_target} and assists in {settings.assist_target} each co-op day
        {settings.hall_counts_as_assist ? " (a period as hall monitor counts as assisting)" : ""}. Counts come from class
        assignments and hall monitors for each term; a cell changed by hand is marked.
      </p>
    </div>

    <div className="tc-controls">
      <label><span className="field-caption">School year</span>
        <select value={data.school_year?.id ?? ""} onChange={(event) => setYearId(event.target.value || null)}>
          {data.years.map((year) => <option key={year.id} value={year.id}>{year.label}{year.is_current ? " (current)" : ""}</option>)}
        </select>
      </label>
      <label><span className="field-caption">Group</span>
        <select value={view} onChange={(event) => setView(event.target.value as View)}>
          <option value="household">By household</option><option value="everyone">Everyone</option>
        </select>
      </label>
      <label><span className="field-caption">Show</span>
        <select value={show} onChange={(event) => setShow(event.target.value as Show)}>
          <option value="all">Everyone</option>
          <option value="short">Households below the expectation</option>
          <option value="heavy">Adults carrying a lot</option>
        </select>
      </label>
      <label><span className="field-caption">Sort by total roles</span>
        <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          <option value="most">Most first</option><option value="fewest">Fewest first</option><option value="name">Name</option>
        </select>
      </label>
      <label className="tc-search"><span className="field-caption">Find</span>
        <input type="search" value={search} placeholder="Name or household" onChange={(event) => setSearch(event.target.value)} />
      </label>
    </div>

    {!data.school_year && <p className="portal-empty">There is no school year yet. Add one under Classes.</p>}
    {data.school_year && !terms.length && <p className="portal-empty">This school year has no terms yet. Add them under Classes, Schedule &amp; enrollment settings.</p>}

    {data.school_year && terms.length > 0 && <>
      <p className="tc-summary" role="status">
        <span className={`tc-chip ${shortCount ? "short" : "ok"}`}>{shortCount ? `${shortCount} of ${households.length} households below the expectation` : `All ${households.length} households meet the expectation`}</span>
        {heavyCount > 0 && <span className="tc-chip heavy">{heavyCount} adult{heavyCount === 1 ? "" : "s"} carrying a lot ({settings.heavy_load}+ roles in a term)</span>}
      </p>

      <div className="tc-scroller" role="region" aria-label="Teaching commitment table">
        <table className="tc-table">
          <thead>
            <tr>
              <th rowSpan={2} className="tc-name" scope="col">Name</th>
              {terms.map((term) => <th key={term.id} colSpan={3} className="tc-term-start" scope="colgroup">{term.label}</th>)}
              <th colSpan={3} className="tc-term-start" scope="colgroup">Year</th>
              <th rowSpan={2} scope="col">Total roles</th>
              <th rowSpan={2} scope="col">Blocks</th>
              <th rowSpan={2} scope="col" className="tc-notes">Notes / classes covered</th>
            </tr>
            <tr>
              {[...terms.map((term) => term.id), "year"].map((id) => ROLES.map((role, index) =>
                <th key={`${id}-${role}`} scope="col" className={`tc-sub${index === 0 ? " tc-term-start" : ""}`} title={ROLE_LABEL[role]}>
                  <abbr title={ROLE_LABEL[role]}>{ROLE_SHORT[role]}</abbr>
                </th>))}
            </tr>
          </thead>
          <tbody>
            {view === "everyone" && visiblePeople.map((person) => <PersonRow key={person.key} person={person} terms={terms} showHousehold onCell={editCell} onPerson={setPersonOpen} />)}
            {view === "household" && <>
              {visibleHouseholds.map((household) => <HouseholdRows key={household.id} household={household} terms={terms} settings={settings}
                members={order(people.filter((person) => person.household_id === household.id))} columnCount={columnCount}
                onCell={editCell} onPerson={setPersonOpen} />)}
              {loose.length > 0 && <>
                <tr className="tc-household-row"><th colSpan={columnCount} scope="rowgroup">Not in a household <small>Teachers without a household, and names kept from the spreadsheet</small></th></tr>
                {loose.map((person) => <PersonRow key={person.key} person={person} terms={terms} onCell={editCell} onPerson={setPersonOpen} />)}
              </>}
            </>}
            {(view === "everyone" ? visiblePeople.length : visibleHouseholds.length + loose.length) === 0 &&
              <tr><td colSpan={columnCount} className="portal-empty">Nobody matches.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="field-note">T taught, A assisted, H hall monitor. A dashed cell was changed by hand or imported; select any cell to see why or to change it.</p>

      <div className="report-actions">
        <button type="button" disabled={busy} onClick={() => void exportAs("pdf")}>Download PDF</button>
        <button type="button" className="ghost" onClick={() => void exportAs("csv")}>Export CSV</button>
        {status && <p className="admin-form-status" role="status">{status}</p>}
      </div>

      <HallMonitorsCard data={data} onChanged={reload} />
      <CommitmentImport data={data} onSaved={reload} />
    </>}
    <CommitmentSettingsCard settings={settings} onSaved={reload} />

    {editing && <CellEditor data={data} editing={editing} onClose={() => setEditing(null)} onSaved={async () => {
      const next = await reload();
      const person = next?.people?.find((row) => row.key === editing.person.key);
      if (person) setEditing({ ...editing, person });
    }} />}
    {personOpen && <PersonPanel data={data} person={personOpen} onClose={() => setPersonOpen(null)} onSaved={async () => {
      const next = await reload();
      setPersonOpen(next?.people?.find((row) => row.key === personOpen.key) ?? null);
    }} />}
  </section>;
}

function Cell({ person, term, role, onCell }: { person: CommitmentPerson; term: CommitmentTerm; role: CommitmentRole; onCell: (person: CommitmentPerson, term: CommitmentTerm, role: CommitmentRole) => void }) {
  const cell = cellOf(person, term.id, role);
  const adjusted = isAdjusted(cell);
  return <td className={`tc-cell${role === "taught" ? " tc-term-start" : ""}${adjusted ? " adjusted" : ""}${cell.value === 0 ? " zero" : ""}`}>
    <button type="button" onClick={() => onCell(person, term, role)}
      aria-label={`${person.name}, ${term.label}, ${ROLE_LABEL[role]}: ${cell.value}${adjusted ? ", changed by hand" : ""}`}>
      {cell.value}
    </button>
  </td>;
}

function PersonRow({ person, terms, showHousehold, onCell, onPerson }: {
  person: CommitmentPerson; terms: CommitmentTerm[]; showHousehold?: boolean;
  onCell: (person: CommitmentPerson, term: CommitmentTerm, role: CommitmentRole) => void; onPerson: (person: CommitmentPerson) => void;
}) {
  return <tr className={person.heavy ? "tc-heavy" : ""}>
    <th scope="row" className="tc-name">
      <button type="button" className="tc-person" onClick={() => onPerson(person)}>
        <b>{person.name}</b>
        {showHousehold && <small>{person.household_name ?? (person.user_id ? "No household" : "No account")}</small>}
        {!showHousehold && !person.user_id && <small>No account</small>}
      </button>
      {person.heavy && <span className="tc-chip heavy small">Carrying a lot</span>}
    </th>
    {terms.map((term) => ROLES.map((role) => <Cell key={`${term.id}-${role}`} person={person} term={term} role={role} onCell={onCell} />))}
    <td className="tc-num tc-term-start">{person.taught}</td>
    <td className="tc-num">{person.assisted}</td>
    <td className="tc-num">{person.hall_monitor}</td>
    <td className="tc-num tc-strong">{person.total_roles}</td>
    <td className="tc-num">{person.blocks_participated}</td>
    <td className="tc-notes">{coveredText(person, terms)}</td>
  </tr>;
}

function HouseholdRows({ household, members, terms, settings, columnCount, onCell, onPerson }: {
  household: CommitmentHousehold; members: CommitmentPerson[]; terms: CommitmentTerm[]; settings: CommitmentData["settings"];
  columnCount: number; onCell: (person: CommitmentPerson, term: CommitmentTerm, role: CommitmentRole) => void; onPerson: (person: CommitmentPerson) => void;
}) {
  const byTerm = new Map((household.terms ?? []).map((term) => [term.term_id, term]));
  const shortTerms = terms.filter((term) => { const row = byTerm.get(term.id); return row && row.checked && !row.meets; });
  return <>
    <tr className={`tc-household-row${household.meets ? "" : " below"}`}>
      <th colSpan={columnCount} scope="rowgroup">
        {household.name}
        {household.meets
          ? <span className="tc-chip ok small">Meets the expectation</span>
          : <span className="tc-chip short small">Below in {shortTerms.map((term) => term.label).join(", ")}</span>}
      </th>
    </tr>
    {members.map((person) => <PersonRow key={person.key} person={person} terms={terms} onCell={onCell} onPerson={onPerson} />)}
    {members.length === 0 && <tr><td colSpan={columnCount} className="tc-notes">No active adults in this household.</td></tr>}
    <tr className="tc-total-row">
      <th scope="row" className="tc-name">Household total</th>
      {terms.map((term) => {
        const row = byTerm.get(term.id);
        const need = row ? shortfall(row, settings) : "";
        return ROLES.map((role, index) => <td key={`${term.id}-${role}`} className={`tc-num${index === 0 ? " tc-term-start" : ""}${need ? " tc-short" : ""}`}
          title={need ? `${term.label}: ${need}` : undefined}>{row?.[role] ?? 0}</td>);
      })}
      <td className="tc-num tc-term-start">{household.taught}</td>
      <td className="tc-num">{household.assisted}</td>
      <td className="tc-num">{household.hall_monitor}</td>
      <td className="tc-num tc-strong">{household.total_roles}</td>
      <td />
      <td className="tc-notes">{shortTerms.map((term) => `${term.label}: ${shortfall(byTerm.get(term.id)!, settings)}`).join("; ")}</td>
    </tr>
  </>;
}

const SOURCE_LABEL = { manual: "By hand", import: "From the spreadsheet", substitute: "From a substitution" } as const;

function CellEditor({ data, editing, onClose, onSaved }: { data: CommitmentData; editing: Editing; onClose: () => void; onSaved: () => Promise<void> }) {
  const { person, term, role } = editing;
  const cell = cellOf(person, term.id, role);
  const entries = (data.entries ?? []).filter((entry) => entry.person_key === person.key && entry.term_id === term.id && entry.role === role);
  const [kind, setKind] = useState<"adjust" | "set">("adjust");
  const [amount, setAmount] = useState("1");
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const periods = new Map((data.periods ?? []).map((period) => [period.id, period.label]));
  const fromPortal = role === "hall_monitor"
    ? person.hall.filter((row) => row.term_id === term.id).map((row) => `Hall monitor, ${periods.get(row.block_id) ?? "a period"}`)
    : person.classes.filter((row) => row.term_id === term.id && row.role === role).map((row) => row.title);

  async function save() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_save_commitment_entry", {
      p_term_id: term.id, p_user_id: person.user_id, p_person_label: person.user_id ? null : person.label,
      p_role: role, p_kind: kind, p_amount: Number(amount), p_reason: reason,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setReason(""); setMessage("Saved.");
    await onSaved();
  }

  async function remove(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_remove_commitment_entry", { p_entry_id: id, p_reason: removeReason });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setRemoving(null); setRemoveReason(""); setMessage("Removed.");
    await onSaved();
  }

  return <DetailModal title={`${person.name}: ${term.label}, ${ROLE_LABEL[role]}`} onClose={onClose}>
    <dl className="tc-breakdown">
      <div><dt>From the portal</dt><dd>{cell.auto}{fromPortal.length ? ` (${fromPortal.join(", ")})` : ""}</dd></div>
      {cell.set !== null && <div><dt>Set by hand or imported</dt><dd>{cell.set} (replaces the portal&rsquo;s count)</dd></div>}
      {cell.adjust !== 0 && <div><dt>Adjustments</dt><dd>{cell.adjust > 0 ? `+${cell.adjust}` : cell.adjust}</dd></div>}
      <div><dt>Counted</dt><dd><b>{cell.value}</b></dd></div>
    </dl>

    {entries.length > 0 && <>
      <p className="card-kicker">History</p>
      <ul className="tc-history">
        {entries.map((entry) => <li key={entry.id} className={entry.removed_at ? "removed" : ""}>
          <div>
            <b>{entry.kind === "set" ? `Set to ${entry.amount}` : entry.amount > 0 ? `+${entry.amount}` : String(entry.amount)}</b>
            {" "}{entry.reason}
            <small>{SOURCE_LABEL[entry.source]}{entry.created_by_name ? `, ${entry.created_by_name}` : ""}, {new Date(entry.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {entry.removed_at && ` · Removed${entry.removed_by_name ? ` by ${entry.removed_by_name}` : ""}: ${entry.removed_reason}`}</small>
          </div>
          {!entry.removed_at && removing !== entry.id && <button type="button" className="ghost" onClick={() => { setRemoving(entry.id); setRemoveReason(""); }}>Remove</button>}
          {removing === entry.id && <div className="tc-remove">
            <label><span className="field-caption">Why remove it?</span><input value={removeReason} maxLength={500} onChange={(event) => setRemoveReason(event.target.value)} /></label>
            <div className="row-actions">
              <button type="button" className="danger" disabled={busy || removeReason.trim().length < 3} onClick={() => void remove(entry.id)}>Remove entry</button>
              <button type="button" className="ghost" onClick={() => setRemoving(null)}>Keep</button>
            </div>
          </div>}
        </li>)}
      </ul>
    </>}

    <div className="portal-form">
      <p className="card-kicker">Change this count</p>
      <label><span className="field-caption">How</span>
        <select value={kind} onChange={(event) => { setKind(event.target.value as "adjust" | "set"); setAmount(event.target.value === "set" ? String(cell.value) : "1"); }}>
          <option value="adjust">Add or take away (a substitution, work outside the portal)</option>
          <option value="set">Set the count, replacing the portal&rsquo;s</option>
        </select>
      </label>
      <label><span className="field-caption">{kind === "adjust" ? "By (use a minus sign to take away)" : "Count"}</span>
        <input type="number" inputMode="numeric" min={kind === "adjust" ? -12 : 0} max={12} step={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label><span className="field-caption">Reason</span>
        <textarea value={reason} maxLength={500} rows={2} placeholder="For example: covered Science for another family on the 14th" onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="row-actions">
        <button type="button" disabled={busy || reason.trim().length < 3 || amount === "" || (kind === "adjust" && Number(amount) === 0)} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </div>
      {message && <p className="admin-form-status" role="status">{message}</p>}
    </div>
  </DetailModal>;
}

function PersonPanel({ data, person, onClose, onSaved }: { data: CommitmentData; person: CommitmentPerson; onClose: () => void; onSaved: () => Promise<void> }) {
  const [note, setNote] = useState(person.note ?? "");
  const [linkTo, setLinkTo] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const terms = data.terms ?? [];
  const periods = new Map((data.periods ?? []).map((period) => [period.id, period.label]));

  async function saveNote() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !data.school_year) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_save_commitment_note", {
      p_school_year_id: data.school_year.id, p_user_id: person.user_id, p_person_label: person.user_id ? null : person.label, p_note: note,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Note saved.");
    await onSaved();
  }

  async function link() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !data.school_year || !linkTo || !person.label) return;
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_link_commitment_label", { p_school_year_id: data.school_year.id, p_person_label: person.label, p_user_id: linkTo });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    await onSaved();
    onClose();
  }

  return <DetailModal title={person.name} onClose={onClose}>
    <p className="field-note">{person.household_name ? `Household: ${person.household_name}` : person.user_id ? "Not in a household" : "A name kept from the spreadsheet, with no portal account"}</p>
    <p className="card-kicker">Classes covered</p>
    <ul className="tc-history">
      {terms.map((term) => {
        const classes = person.classes.filter((row) => row.term_id === term.id);
        const hall = person.hall.filter((row) => row.term_id === term.id);
        if (!classes.length && !hall.length) return null;
        return <li key={term.id}><div><b>{term.label}</b> {[
          ...classes.map((row) => `${row.title}${row.role === "assisted" ? " (assisting)" : " (teaching)"}`),
          ...hall.map((row) => `hall monitor, ${periods.get(row.block_id) ?? "a period"}`),
        ].join(", ")}</div></li>;
      })}
      {!person.classes.length && !person.hall.length && <li><div>No class or hall monitor assignments in the portal this year.</div></li>}
    </ul>
    <div className="portal-form">
      <label><span className="field-caption">Notes</span>
        <textarea value={note} rows={3} maxLength={2000} placeholder="Classes covered outside the portal, substitutions, anything to remember" onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="row-actions"><button type="button" disabled={busy} onClick={() => void saveNote()}>Save note</button></div>
      {!person.user_id && person.label && <>
        <label><span className="field-caption">Link to a portal account</span>
          <select value={linkTo} onChange={(event) => setLinkTo(event.target.value)}>
            <option value="">Choose a person…</option>
            {(data.candidates ?? []).map((candidate) => <option key={candidate.user_id} value={candidate.user_id}>
              {candidate.name}{candidate.household_name ? ` (${candidate.household_name})` : ""}</option>)}
          </select>
        </label>
        <p className="field-note">Moves this name&rsquo;s counts and note to the account. The old entries stay in the history.</p>
        <div className="row-actions"><button type="button" disabled={busy || !linkTo} onClick={() => void link()}>Link</button></div>
      </>}
      {message && <p className="admin-form-status" role="status">{message}</p>}
    </div>
  </DetailModal>;
}
