/**
 * Reports as plain data.
 *
 * Every report is built once into a `ReportDoc` (a title and one or more
 * tables of text), and the same document is shown on screen, written to CSV,
 * and drawn into a PDF. That keeps the three from drifting apart, and keeps
 * these builders free of the browser so they can be checked on their own.
 */

export type ReportColumn = {
  label: string;
  /** Relative width; columns share the page in proportion. Default 1. */
  weight?: number;
};

export type ReportSection = {
  heading?: string;
  /** Right-aligned text beside the heading, such as a hall monitor. */
  aside?: string;
  columns: ReportColumn[];
  rows: string[][];
};

export type ReportDoc = {
  title: string;
  subtitle?: string;
  sections: ReportSection[];
  /** Wide tables print sideways. */
  landscape: boolean;
};

// --- inputs ----------------------------------------------------------------

export type RosterBlock = { id: string; label: string; starts_at: string; ends_at: string; sort_order: number };

export type RosterStudent = {
  childId: string;
  first: string;
  lastInitial: string | null;
  household: string;
  status: string;
};

export type RosterTeacher = { role: "lead" | "assistant"; name: string };

export type RosterClass = {
  id: string;
  title: string;
  grades: string[];
  block: RosterBlock | null;
  room: string | null;
  termIds: string[];
  teachers: RosterTeacher[];
  students: RosterStudent[];
};

// --- small helpers -----------------------------------------------------------

const GRADES = ["Pre-K", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

/** "K–3, 7"; an empty list reads "All". */
export function gradeSpan(grades: string[]): string {
  if (!grades.length) return "All";
  const ordered = GRADES.filter((grade) => grades.includes(grade));
  const runs: string[][] = [];
  for (const grade of ordered) {
    const last = runs[runs.length - 1];
    if (last && GRADES.indexOf(grade) === GRADES.indexOf(last[last.length - 1]) + 1) last.push(grade);
    else runs.push([grade]);
  }
  return runs.map((run) => (run.length > 2 ? `${run[0]}–${run[run.length - 1]}` : run.join(", "))).join(", ");
}

/** Youngest grade first, so a roster reads from the little ones up. */
function gradeRank(grades: string[]): number {
  const ranks = grades.map((grade) => GRADES.indexOf(grade)).filter((rank) => rank >= 0);
  return ranks.length ? Math.min(...ranks) : 99;
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** "9:00 AM" from a Postgres time such as "09:00:00". */
export function clock(value: string): string {
  const [rawHour, rawMinute] = value.split(":");
  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${(rawMinute ?? "00").padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function blockLabel(block: RosterBlock | null): string {
  return block ? `${block.label} (${clock(block.starts_at)} – ${clock(block.ends_at)})` : "Not scheduled";
}

function byBlock(classes: RosterClass[]): { block: RosterBlock | null; classes: RosterClass[] }[] {
  const groups = new Map<string, { block: RosterBlock | null; classes: RosterClass[] }>();
  for (const klass of classes) {
    const key = klass.block?.id ?? "none";
    const group = groups.get(key) ?? { block: klass.block, classes: [] };
    group.classes.push(klass);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.block?.sort_order ?? 999) - (b.block?.sort_order ?? 999));
}

const activeStudents = (klass: RosterClass) => klass.students.filter((student) => student.status === "active");

/** First names, with a last initial only where two children in the class share a first name. */
function studentNames(students: RosterStudent[]): string[] {
  const counts = new Map<string, number>();
  for (const student of students) counts.set(student.first.toLowerCase(), (counts.get(student.first.toLowerCase()) ?? 0) + 1);
  return students
    .map((student) => (counts.get(student.first.toLowerCase())! > 1 && student.lastInitial ? `${student.first} ${student.lastInitial}.` : student.first))
    .sort((a, b) => a.localeCompare(b));
}

const termsMatch = (klass: RosterClass, termId: string | null) =>
  !termId || klass.termIds.length === 0 || klass.termIds.includes(termId);

// --- reports ----------------------------------------------------------------------

/** The class roster sheet: one table per period, each class a row, students listed across. */
export function buildRoster(
  classes: RosterClass[],
  options: { yearLabel: string; termLabel: string | null; termId: string | null; hall?: Record<string, string> },
): ReportDoc {
  const sections: ReportSection[] = [];
  for (const group of byBlock(classes.filter((klass) => termsMatch(klass, options.termId)))) {
    const ordered = [...group.classes].sort((a, b) => gradeRank(a.grades) - gradeRank(b.grades) || a.title.localeCompare(b.title));
    const hall = group.block ? options.hall?.[group.block.id]?.trim() : "";
    sections.push({
      heading: blockLabel(group.block),
      aside: hall ? `Hall: ${hall}` : undefined,
      columns: [
        { label: "Class", weight: 2.2 }, { label: "Room", weight: 0.7 }, { label: "Ages", weight: 0.9 },
        { label: "Teacher", weight: 1.2 }, { label: "Assistant", weight: 1.2 }, { label: "Students", weight: 6 },
      ],
      rows: ordered.map((klass) => [
        klass.title.toUpperCase(),
        klass.room ?? "",
        gradeSpan(klass.grades),
        klass.teachers.filter((t) => t.role === "lead").map((t) => firstName(t.name)).join(", "),
        klass.teachers.filter((t) => t.role === "assistant").map((t) => firstName(t.name)).join(", "),
        studentNames(activeStudents(klass)).join(" · "),
      ]),
    });
  }
  return {
    title: `${options.yearLabel} Class Roster${options.termLabel ? ` – ${options.termLabel}` : ""}`,
    sections, landscape: true,
  };
}

/** One row per student: which class they are in during each period. */
export function buildStudentSchedules(classes: RosterClass[], options: { yearLabel: string; termLabel: string | null; termId: string | null }): ReportDoc {
  const inTerm = classes.filter((klass) => termsMatch(klass, options.termId));
  const blocks = byBlock(inTerm).map((group) => group.block).filter((block): block is RosterBlock => !!block);
  const students = new Map<string, { name: string; household: string; cells: Map<string, string[]> }>();
  for (const klass of inTerm) {
    for (const student of activeStudents(klass)) {
      const entry = students.get(student.childId) ?? { name: `${student.first} ${student.lastInitial ?? ""}`.trim(), household: student.household, cells: new Map() };
      const key = klass.block?.id ?? "none";
      entry.cells.set(key, [...(entry.cells.get(key) ?? []), klass.room ? `${klass.title} (${klass.room})` : klass.title]);
      students.set(student.childId, entry);
    }
  }
  return {
    title: `${options.yearLabel} Student Schedules${options.termLabel ? ` – ${options.termLabel}` : ""}`,
    landscape: true,
    sections: [{
      columns: [{ label: "Student", weight: 1.4 }, { label: "Household", weight: 1.2 }, ...blocks.map((block) => ({ label: block.label, weight: 2 }))],
      rows: [...students.values()].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [
        entry.name, entry.household, ...blocks.map((block) => (entry.cells.get(block.id) ?? []).join("; ")),
      ]),
    }],
  };
}

/** One row per teacher: what they teach or assist in each period. */
export function buildTeacherSchedule(classes: RosterClass[], options: { yearLabel: string; termLabel: string | null; termId: string | null }): ReportDoc {
  const inTerm = classes.filter((klass) => termsMatch(klass, options.termId));
  const blocks = byBlock(inTerm).map((group) => group.block).filter((block): block is RosterBlock => !!block);
  const teachers = new Map<string, Map<string, string[]>>();
  for (const klass of inTerm) {
    for (const teacher of klass.teachers) {
      const cells = teachers.get(teacher.name) ?? new Map<string, string[]>();
      const key = klass.block?.id ?? "none";
      cells.set(key, [...(cells.get(key) ?? []), `${klass.title}${teacher.role === "assistant" ? " (assistant)" : ""}${klass.room ? `, ${klass.room}` : ""}`]);
      teachers.set(teacher.name, cells);
    }
  }
  return {
    title: `${options.yearLabel} Teacher Schedule${options.termLabel ? ` – ${options.termLabel}` : ""}`,
    landscape: true,
    sections: [{
      columns: [{ label: "Teacher", weight: 1.2 }, ...blocks.map((block) => ({ label: block.label, weight: 2 }))],
      rows: [...teachers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, cells]) => [name, ...blocks.map((block) => (cells.get(block.id) ?? []).join("; "))]),
    }],
  };
}

/** A list per class, with each student's household and whether they are enrolled or waitlisted. */
export function buildClassLists(classes: RosterClass[], options: { yearLabel: string; termLabel: string | null; termId: string | null }): ReportDoc {
  const sections: ReportSection[] = [];
  for (const group of byBlock(classes.filter((klass) => termsMatch(klass, options.termId)))) {
    for (const klass of [...group.classes].sort((a, b) => a.title.localeCompare(b.title))) {
      const people = [...klass.students].sort((a, b) => a.first.localeCompare(b.first));
      sections.push({
        heading: klass.title,
        aside: [group.block?.label, klass.room].filter(Boolean).join(" · "),
        columns: [{ label: "#", weight: 0.4 }, { label: "Student", weight: 2 }, { label: "Household", weight: 2 }, { label: "Status", weight: 1 }],
        rows: people.map((student, index) => [String(index + 1), `${student.first} ${student.lastInitial ?? ""}`.trim(), student.household, student.status === "active" ? "Enrolled" : student.status]),
      });
    }
  }
  return { title: `${options.yearLabel} Class Lists${options.termLabel ? ` – ${options.termLabel}` : ""}`, sections, landscape: false };
}

/** Where scheduling is incomplete: no teachers, no students, no time, no room. */
export function buildClassReadiness(classes: RosterClass[], options: { yearLabel: string }): ReportDoc {
  const rows = [...classes]
    .sort((a, b) => (a.block?.sort_order ?? 999) - (b.block?.sort_order ?? 999) || a.title.localeCompare(b.title))
    .map((klass) => {
      const students = activeStudents(klass).length;
      const issues = [klass.teachers.length < 2 ? "Needs teachers" : "", students === 0 ? "No students" : "", !klass.block ? "No time" : "", !klass.room ? "No room" : ""].filter(Boolean);
      return [klass.block?.label ?? "Not scheduled", klass.title, klass.room ?? "", String(klass.teachers.length), String(students), issues.join(" · ") || "Ready"];
    });
  return {
    title: `${options.yearLabel} Class Readiness`, landscape: false,
    sections: [{ columns: [{ label: "Period", weight: 1.3 }, { label: "Class", weight: 2 }, { label: "Room", weight: 1 }, { label: "Teachers", weight: 0.8 }, { label: "Students", weight: 0.8 }, { label: "Status", weight: 1.6 }], rows }],
  };
}

/** Every table in a document as CSV rows; a leading Section column is added when there are several tables. */
export function docToRows(doc: ReportDoc): string[][] {
  const several = doc.sections.length > 1;
  const labels = (section: ReportSection) => section.columns.map((column) => column.label).join("|");
  const out: string[][] = [];
  doc.sections.forEach((section, index) => {
    // A header row starts the file, and again wherever the columns change.
    if (index === 0 || labels(section) !== labels(doc.sections[index - 1])) {
      if (index > 0) out.push([]);
      out.push([...(several ? ["Section"] : []), ...section.columns.map((column) => column.label)]);
    }
    for (const row of section.rows) out.push([...(several ? [section.heading ?? ""] : []), ...row]);
  });
  return out;
}
