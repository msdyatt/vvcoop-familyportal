"use client";

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { downloadCsv, toCsv } from "../../../lib/csv";
import { printElement } from "../../../lib/dom";
import {
  buildClassLists, buildClassReadiness, buildRoster, buildStudentSchedules, buildTeacherSchedule, docToRows,
  type ReportDoc, type RosterClass,
} from "../../../lib/report-doc";
import { buildFamilyDirectory, buildFamilyReadiness, type FamilyRow, type RequirementRow, type TeacherLink } from "../../../lib/report-doc-families";
import { deliverPdf, makePdf } from "../../../lib/report-pdf";

type ReportId = "roster" | "schedules" | "teachers" | "lists" | "class-readiness" | "family-readiness" | "directory";

const REPORTS: { id: ReportId; title: string; blurb: string; kind: "classes" | "families" }[] = [
  { id: "roster", title: "Class rosters by period", blurb: "Every class in each period with its room, ages, teacher, assistant and students. Choose the block.", kind: "classes" },
  { id: "schedules", title: "Student schedules", blurb: "One row per student: which class they are in each period.", kind: "classes" },
  { id: "teachers", title: "Teacher schedule", blurb: "One row per teacher: what they teach or assist in each period.", kind: "classes" },
  { id: "lists", title: "Class lists", blurb: "A list per class with each student's household and enrollment status.", kind: "classes" },
  { id: "class-readiness", title: "Class readiness", blurb: "Classes still missing teachers, students, a time or a room.", kind: "classes" },
  { id: "family-readiness", title: "Family readiness", blurb: "Dues and paperwork status, household by household.", kind: "families" },
  { id: "directory", title: "Family directory", blurb: "Adults with email and phone, and the children in each household.", kind: "families" },
];

type Term = { id: string; label: string };
type ClassData = { yearLabel: string; terms: Term[]; classes: RosterClass[] };
type FamilyData = { yearLabel: string; families: FamilyRow[]; requirements: RequirementRow[]; teacherLinks: TeacherLink[] };

const CLASS_SELECT = "id,title,grades,class_blocks(id,label,starts_at,ends_at,sort_order),rooms(name),class_terms(term_id),teacher_assignments(assignment_role,profiles(display_name,email)),enrollments(status,child_id,children(first_name,last_initial,families(display_name,last_name))),school_years!inner(label,is_current)";

async function loadClassData(): Promise<ClassData | null> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const { data: year } = await supabase.from("school_years").select("id,label").eq("is_current", true).maybeSingle();
  const [{ data: classRows }, { data: termRows }] = await Promise.all([
    supabase.from("classes").select(CLASS_SELECT).eq("active", true).eq("school_years.is_current", true).order("title"),
    year ? supabase.from("academic_terms").select("id,label").eq("school_year_id", year.id).order("sort_order").order("starts_on") : Promise.resolve({ data: [] }),
  ]);
  type Raw = {
    id: string; title: string; grades: string[] | null;
    class_blocks: RosterClass["block"]; rooms: { name: string } | null; class_terms: { term_id: string }[];
    teacher_assignments: { assignment_role: "lead" | "assistant"; profiles: { display_name: string | null; email: string } | null }[];
    enrollments: { status: string; child_id: string; children: { first_name: string; last_initial: string | null; families: { display_name: string; last_name: string | null } | null } | null }[];
  };
  const classes = ((classRows ?? []) as unknown as Raw[]).map((row): RosterClass => ({
    id: row.id, title: row.title, grades: row.grades ?? [], block: row.class_blocks, room: row.rooms?.name ?? null,
    termIds: row.class_terms.map((link) => link.term_id),
    teachers: row.teacher_assignments.map((link) => ({ role: link.assignment_role, name: link.profiles?.display_name || link.profiles?.email || "Teacher" })),
    students: row.enrollments.filter((entry) => entry.children).map((entry) => ({
      childId: entry.child_id, first: entry.children!.first_name, lastInitial: entry.children!.last_initial,
      household: entry.children!.families?.last_name || entry.children!.families?.display_name || "", status: entry.status,
    })),
  }));
  return { yearLabel: year?.label ?? "", terms: (termRows ?? []) as Term[], classes };
}

async function loadFamilyData(): Promise<FamilyData | null> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return null;
  const [{ data: year }, familyResult, requirementResult, teacherResult] = await Promise.all([
    supabase.from("school_years").select("label").eq("is_current", true).maybeSingle(),
    supabase.from("families").select("id,display_name,last_name,children(id,first_name,last_initial,active,age_band),family_members(user_id,profiles(display_name,email,phone,status))").order("display_name"),
    supabase.from("family_requirements").select("family_id,status,requirements!inner(kind,title,active,school_years!inner(is_current))").eq("requirements.active", true).eq("requirements.school_years.is_current", true),
    supabase.from("teacher_assignments").select("user_id,class_id,classes!inner(school_years!inner(is_current))").eq("classes.school_years.is_current", true),
  ]);
  return {
    yearLabel: year?.label ?? "",
    families: (familyResult.data ?? []) as unknown as FamilyRow[],
    requirements: (requirementResult.data ?? []) as unknown as RequirementRow[],
    teacherLinks: (teacherResult.data ?? []) as TeacherLink[],
  };
}

export default function ReportsTab() {
  const [selected, setSelected] = useState<ReportId | null>(null);
  // Each kind of data is fetched the first time a report needs it, then kept.
  const [classData, setClassData] = useState<ClassData | null>(null);
  const [familyData, setFamilyData] = useState<FamilyData | null>(null);
  const [failed, setFailed] = useState(false);

  const open = useCallback(async (id: ReportId) => {
    setSelected(id);
    const kind = REPORTS.find((report) => report.id === id)?.kind;
    try {
      if (kind === "classes" && !classData) setClassData(await loadClassData());
      if (kind === "families" && !familyData) setFamilyData(await loadFamilyData());
    } catch { setFailed(true); }
  }, [classData, familyData]);

  const meta = REPORTS.find((report) => report.id === selected);

  if (!selected || !meta) {
    return <section className="reports-tab">
      <div className="section-heading"><div><p className="card-kicker">Reports</p><h2>Print what you need.</h2></div><p>Choose a report. Each one prints, saves as a PDF, or exports to a spreadsheet, and always reflects the portal&rsquo;s current records.</p></div>
      <ul className="report-picker">
        {REPORTS.map((report) => <li key={report.id}>
          <button type="button" onClick={() => void open(report.id)}><b>{report.title}</b><span>{report.blurb}</span></button>
        </li>)}
      </ul>
    </section>;
  }

  const ready = meta.kind === "classes" ? !!classData : !!familyData;
  return <section className="reports-tab">
    <button type="button" className="ghost report-back no-print" onClick={() => setSelected(null)}>← All reports</button>
    {failed && <p className="admin-form-status" role="alert">Those records could not be loaded. Try again in a moment.</p>}
    {!ready && !failed && <p className="portal-empty" role="status">Preparing the report…</p>}
    {ready && meta.kind === "classes" && classData && <ClassReport id={selected} data={classData} />}
    {ready && meta.kind === "families" && familyData && <FamilyReport id={selected} data={familyData} />}
  </section>;
}

function ClassReport({ id, data }: { id: ReportId; data: ClassData }) {
  const [termId, setTermId] = useState<string>("");
  const [hall, setHall] = useState<Record<string, string>>({});
  const deferredHall = useDeferredValue(hall);
  const term = data.terms.find((entry) => entry.id === termId) ?? null;
  const options = { yearLabel: data.yearLabel, termLabel: term?.label ?? null, termId: term?.id ?? null };

  const doc = useMemo<ReportDoc>(() => {
    if (id === "roster") return buildRoster(data.classes, { ...options, hall: deferredHall });
    if (id === "schedules") return buildStudentSchedules(data.classes, options);
    if (id === "teachers") return buildTeacherSchedule(data.classes, options);
    if (id === "lists") return buildClassLists(data.classes, options);
    return buildClassReadiness(data.classes, { yearLabel: data.yearLabel });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options is rebuilt from these two each render
  }, [id, data, term?.id, deferredHall]);

  // The periods that appear in the chosen block, so each can be given a hall monitor.
  const periods = useMemo(() => {
    const seen = new Map<string, { id: string; label: string; order: number }>();
    for (const klass of data.classes) {
      if (!klass.block) continue;
      if (term && klass.termIds.length && !klass.termIds.includes(term.id)) continue;
      seen.set(klass.block.id, { id: klass.block.id, label: klass.block.label, order: klass.block.sort_order });
    }
    return [...seen.values()].sort((a, b) => a.order - b.order);
  }, [data.classes, term]);

  return <>
    {id !== "class-readiness" && <div className="report-options no-print">
      <label><span className="field-caption">Block</span>
        <select value={termId} onChange={(event) => setTermId(event.target.value)}>
          <option value="">All blocks</option>
          {data.terms.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      {id === "roster" && periods.map((period) => <label key={period.id}><span className="field-caption">{period.label} hall monitor</span>
        <input value={hall[period.id] ?? ""} maxLength={40} placeholder="Optional" onChange={(event) => setHall({ ...hall, [period.id]: event.target.value })} />
      </label>)}
    </div>}
    <ReportSheet doc={doc} filename={filenameFor(id, term?.label)} />
  </>;
}

function FamilyReport({ id, data }: { id: ReportId; data: FamilyData }) {
  const doc = useMemo(() => id === "directory"
    ? buildFamilyDirectory(data.families, data.yearLabel)
    : buildFamilyReadiness(data.families, data.requirements, data.teacherLinks, data.yearLabel), [id, data]);
  return <ReportSheet doc={doc} filename={filenameFor(id)} />;
}

function filenameFor(id: ReportId, termLabel?: string) {
  const day = new Date().toISOString().slice(0, 10);
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `veritas-village-${id}${termLabel ? `-${slug(termLabel)}` : ""}-${day}`;
}

/** The report as a plain sheet (white, no fills), with Print, PDF and CSV at the foot. */
function ReportSheet({ doc, filename }: { doc: ReportDoc; filename: string }) {
  const sheet = useRef<HTMLElement>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function pdf(note: (delivery: string) => string) {
    setBusy(true); setStatus("Preparing the PDF…");
    try {
      const delivery = await deliverPdf(await makePdf(doc), `${filename}.pdf`);
      setStatus(note(delivery));
    } catch {
      setStatus("The PDF could not be made. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function print() {
    // The installed apps have no print dialog, so there Print hands over a PDF
    // (share sheet, which includes Print). In a browser it prints the sheet itself.
    if (document.documentElement.dataset.app === "1") { void pdf(() => "Choose Print from the share sheet."); return; }
    const style = document.createElement("style");
    style.textContent = `@page { size: letter ${doc.landscape ? "landscape" : "portrait"}; margin: 0.5in; }`;
    document.head.appendChild(style);
    window.addEventListener("afterprint", () => style.remove(), { once: true });
    printElement(sheet.current);
  }

  const empty = doc.sections.every((section) => section.rows.length === 0);
  return <>
    <article className="report-sheet" ref={sheet}>
      <header><p>VERITAS VILLAGE</p><h3>{doc.title}</h3></header>
      {empty && <p className="portal-empty">Nothing to show for this choice yet.</p>}
      {doc.sections.map((section, index) => <section key={index} className="report-section">
        {section.heading && <h4><span>{section.heading}</span>{section.aside && <small>{section.aside}</small>}</h4>}
        <table>
          <thead><tr>{section.columns.map((column) => <th key={column.label} style={{ width: `${(100 * (column.weight ?? 1)) / section.columns.reduce((sum, c) => sum + (c.weight ?? 1), 0)}%` }}>{column.label}</th>)}</tr></thead>
          <tbody>{section.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </section>)}
    </article>
    <div className="report-actions no-print">
      <button type="button" disabled={busy} onClick={print}>Print</button>
      <button type="button" className="ghost" disabled={busy} onClick={() => void pdf((delivery) => delivery === "shared" ? "" : delivery === "opened" ? "Opened the PDF." : "Saved the PDF.")}>Download PDF</button>
      <button type="button" className="ghost" onClick={() => downloadCsv(`${filename}.csv`, toCsv(docToRows(doc)))}>Export CSV</button>
      {status && <p className="admin-form-status" role="status">{status}</p>}
    </div>
  </>;
}
