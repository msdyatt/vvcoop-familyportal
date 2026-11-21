/**
 * Teaching commitment tracker (Admin, Classes, Teaching commitment; issue #151).
 *
 * The numbers are worked out in the database (public.admin_teaching_commitment, migration
 * 20261121090000_teaching_commitment.sql). This file holds what the browser does with them, kept free of React so it
 * can be tested on its own (lib/teaching-commitment.test.ts):
 *
 * - the types of the document the database returns;
 * - reading the co-op's spreadsheet, exported as CSV, for the import;
 * - matching the spreadsheet's names to portal accounts;
 * - the report document (lib/report-doc.ts) the screen exports to CSV and PDF.
 *
 * Words: the spreadsheet's "Block" is the portal's term (academic_terms); the portal's class_blocks are periods.
 */
// The same shape as lib/report-doc.ts ReportDoc, written out here because this file is also tested under Deno, which
// cannot resolve that import without an extension. TypeScript treats the two as one type.
type ReportSection = { heading?: string; aside?: string; columns: { label: string; weight?: number }[]; rows: string[][] };
type ReportDoc = { title: string; subtitle?: string; sections: ReportSection[]; landscape: boolean };

// --- what the database returns ----------------------------------------------------------------------------------------

export type CommitmentRole = "taught" | "assisted" | "hall_monitor";
export const ROLES: CommitmentRole[] = ["taught", "assisted", "hall_monitor"];
export const ROLE_LABEL: Record<CommitmentRole, string> = { taught: "Taught", assisted: "Assisted", hall_monitor: "Hall monitor" };
export const ROLE_SHORT: Record<CommitmentRole, string> = { taught: "T", assisted: "A", hall_monitor: "H" };

export type CommitmentCell = {
  term_id: string; role: CommitmentRole;
  /** From assignments. */ auto: number;
  /** An imported or hand-set count that replaces `auto`, if any. */ set: number | null;
  /** The sum of active adjustments. */ adjust: number;
  value: number;
};

export type CommitmentPerson = {
  key: string; user_id: string | null; label: string | null; name: string;
  household_id: string | null; household_name: string | null;
  taught: number; assisted: number; hall_monitor: number; total_roles: number; blocks_participated: number;
  max_term_roles: number; heavy: boolean; note: string | null;
  cells: CommitmentCell[];
  classes: { term_id: string; title: string; role: "taught" | "assisted" }[];
  hall: { term_id: string; block_id: string }[];
};

export type HouseholdTerm = { term_id: string; taught: number; assisted: number; hall_monitor: number; checked: boolean; meets: boolean };

export type CommitmentHousehold = {
  id: string; name: string; terms: HouseholdTerm[] | null;
  taught: number; assisted: number; hall_monitor: number; total_roles: number; short_terms: number; meets: boolean;
};

export type CommitmentEntry = {
  id: string; person_key: string; term_id: string; role: CommitmentRole; kind: "adjust" | "set"; amount: number;
  reason: string; source: "manual" | "import" | "substitute"; source_ref: string | null; created_at: string;
  created_by_name: string | null; removed_at: string | null; removed_reason: string | null; removed_by_name: string | null;
};

export type CommitmentSettings = { teach_target: number; assist_target: number; hall_counts_as_assist: boolean; heavy_load: number };

export type CommitmentTerm = { id: string; label: string; starts_on: string; ends_on: string; checked: boolean };
export type CommitmentPeriod = { id: string; label: string; starts_at: string; ends_at: string };
export type Candidate = { user_id: string; name: string; email: string; household_name: string | null; status: string };

export type CommitmentData = {
  school_year: { id: string; label: string; is_current: boolean } | null;
  years: { id: string; label: string; is_current: boolean }[];
  settings: CommitmentSettings;
  today?: string;
  terms?: CommitmentTerm[];
  periods?: CommitmentPeriod[];
  people?: CommitmentPerson[];
  households?: CommitmentHousehold[];
  hall_monitors?: { term_id: string; block_id: string; user_id: string }[];
  entries?: CommitmentEntry[];
  candidates?: Candidate[];
};

export function cellOf(person: CommitmentPerson, termId: string, role: CommitmentRole): CommitmentCell {
  return person.cells.find((cell) => cell.term_id === termId && cell.role === role)
    ?? { term_id: termId, role, auto: 0, set: null, adjust: 0, value: 0 };
}

/** A cell an admin (or the import) changed by hand, so the screen can mark it. */
export const isAdjusted = (cell: CommitmentCell) => cell.set !== null || cell.adjust !== 0;

/** "Fall A: History K-3 (taught), Pottery (assisted); hall monitor 2 periods". The admins' note comes first. */
export function coveredText(person: CommitmentPerson, terms: { id: string; label: string }[]): string {
  const parts: string[] = [];
  for (const term of terms) {
    const classes = person.classes.filter((row) => row.term_id === term.id)
      .map((row) => `${row.title}${row.role === "assisted" ? " (assisted)" : ""}`);
    const hall = person.hall.filter((row) => row.term_id === term.id).length;
    if (hall) classes.push(`hall monitor ${hall} period${hall === 1 ? "" : "s"}`);
    if (classes.length) parts.push(`${term.label}: ${classes.join(", ")}`);
  }
  return [person.note?.trim(), parts.join("; ")].filter(Boolean).join(" — ");
}

// --- the handbook check -------------------------------------------------------------------------------------------------

/** How far a household's term is from the expectation, in words, or "" when it meets it or is not checked yet. */
export function shortfall(term: HouseholdTerm, settings: CommitmentSettings): string {
  if (!term.checked || term.meets) return "";
  const assisting = term.assisted + (settings.hall_counts_as_assist ? term.hall_monitor : 0);
  const needs: string[] = [];
  if (term.taught < settings.teach_target) needs.push(`teach ${settings.teach_target - term.taught} more`);
  if (assisting < settings.assist_target) needs.push(`assist ${settings.assist_target - assisting} more`);
  return needs.join(", ");
}

// --- reading the spreadsheet ---------------------------------------------------------------------------------------------

/** CSV to rows of cells: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export type SheetBlock = { label: string; columns: Record<CommitmentRole, number> };
export type SheetCounts = Record<CommitmentRole, number>;
export type SheetRow = {
  /** The line in the file, counting from 1. */ line: number;
  name: string;
  /** One per block, in the spreadsheet's order. */ counts: SheetCounts[];
  note: string;
  total: number;
  warnings: string[];
};
export type SkippedRow = { line: number; name: string; why: "blank" | "zero" | "totals"; note: string };
export type ParsedSheet =
  | { ok: true; blocks: SheetBlock[]; rows: SheetRow[]; skipped: SkippedRow[]; warnings: string[] }
  | { ok: false; error: string };

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const roleOf = (header: string): CommitmentRole | null => {
  const word = squash(header);
  if (/^taught\b|^teach/.test(word)) return "taught";
  if (/^assist/.test(word)) return "assisted";
  if (/^hall\b|^monitor/.test(word)) return "hall_monitor";
  return null;
};

/** A count from the sheet: blank is 0; a whole number 0-12; anything else is a problem. */
function count(raw: string): number | null {
  const text = raw.trim();
  if (!text || text === "-" || text === "—") return 0;
  if (/^\d+(\.0+)?$/.test(text)) {
    const value = Number(text);
    return value <= 12 ? value : null;
  }
  return null;
}

/**
 * Reads the co-op's spreadsheet, saved as CSV, in exactly its layout: any title rows, then a two-row header (Name,
 * then Block 1 to Block 4 over three columns each, Taught / Assisted / Hall Monitor beneath), then totals columns and
 * notes. Totals columns are worked out again in the portal and only checked. Blank rows, rows of zeros and a totals
 * row at the foot are skipped.
 */
export function parseCommitmentSheet(text: string): ParsedSheet {
  const table = parseCsv(text);
  const top = table.findIndex((row, index) =>
    row.some((cell) => squash(cell) === "name") && (table[index + 1] ?? []).some((cell) => roleOf(cell) === "taught"));
  if (top < 0) {
    return { ok: false, error: "This does not look like the teaching commitment spreadsheet: there is no Name column with Taught, Assisted and Hall Monitor beneath the blocks." };
  }
  const upper = table[top];
  const lower = table[top + 1];
  const nameCol = upper.findIndex((cell) => squash(cell) === "name");
  const width = Math.max(upper.length, lower.length);

  // Each sub-heading belongs to the nearest heading at or to its left (merged cells come out of a spreadsheet as a
  // label followed by blanks).
  const blocks: SheetBlock[] = [];
  let noteCol = -1;
  let totalRolesCol = -1;
  let owner = "";
  for (let col = 0; col < width; col++) {
    const head = (upper[col] ?? "").trim();
    const sub = (lower[col] ?? "").trim();
    if (head) owner = head;
    if (/note|covered/.test(squash(head)) || /note|covered/.test(squash(sub))) { noteCol = col; continue; }
    if (/total roles?/.test(squash(head)) || /total roles?/.test(squash(sub))) { totalRolesCol = col; continue; }
    const role = roleOf(sub);
    if (!role || col === nameCol || /total|overall|participat/.test(squash(owner))) continue;
    let block = blocks.find((entry) => entry.label === owner);
    if (!block) {
      block = { label: owner || `Block ${blocks.length + 1}`, columns: { taught: -1, assisted: -1, hall_monitor: -1 } };
      blocks.push(block);
    }
    if (block.columns[role] < 0) block.columns[role] = col;
  }
  const incomplete = blocks.filter((block) => ROLES.some((role) => block.columns[role] < 0));
  if (!blocks.length) return { ok: false, error: "No block has Taught, Assisted and Hall Monitor columns." };
  if (incomplete.length) {
    return { ok: false, error: `${incomplete.map((block) => block.label).join(", ")} ${incomplete.length === 1 ? "is" : "are"} missing a Taught, Assisted or Hall Monitor column.` };
  }

  const rows: SheetRow[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  for (let index = top + 2; index < table.length; index++) {
    const raw = table[index];
    const line = index + 1;
    const name = (raw[nameCol] ?? "").replace(/\s+/g, " ").trim();
    const note = noteCol >= 0 ? (raw[noteCol] ?? "").trim() : "";
    if (!name) {
      if (raw.some((cell) => cell.trim())) {
        if (blocks.some((block) => ROLES.some((role) => (count(raw[block.columns[role]] ?? "") ?? 0) > 0))) {
          warnings.push(`Line ${line} has counts but no name, so it was skipped.`);
        }
      }
      skipped.push({ line, name: "", why: "blank", note });
      continue;
    }
    if (/^(grand )?totals?\b/.test(squash(name))) { skipped.push({ line, name, why: "totals", note }); continue; }
    const rowWarnings: string[] = [];
    const counts = blocks.map((block) => {
      const out = { taught: 0, assisted: 0, hall_monitor: 0 } as SheetCounts;
      for (const role of ROLES) {
        const rawCell = raw[block.columns[role]] ?? "";
        const value = count(rawCell);
        if (value === null) rowWarnings.push(`${block.label} ${ROLE_LABEL[role]} "${rawCell.trim()}" is not a count from 0 to 12; it was read as 0.`);
        out[role] = value ?? 0;
      }
      return out;
    });
    const total = counts.reduce((sum, entry) => sum + entry.taught + entry.assisted + entry.hall_monitor, 0);
    if (total === 0) { skipped.push({ line, name, why: "zero", note }); continue; }
    if (totalRolesCol >= 0) {
      const stated = count(raw[totalRolesCol] ?? "");
      if (stated !== null && (raw[totalRolesCol] ?? "").trim() && stated !== total) {
        rowWarnings.push(`The sheet's Total roles is ${stated}, but the blocks add up to ${total}.`);
      }
    }
    rows.push({ line, name, counts, note, total, warnings: rowWarnings });
  }
  return { ok: true, blocks, rows, skipped, warnings };
}

// --- matching names to accounts ------------------------------------------------------------------------------------------

export function normalizeName(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\(.*?\)/g, " ").replace(/['.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export type Match = {
  /** The account to use, or null to decide by hand. */ userId: string | null;
  /** exact: the full name matches one account; likely: a looser match to one account, worth a look; none: pick. */
  confidence: "exact" | "likely" | "none";
  /** Accounts worth offering first. */ suggestions: string[];
};

/** Matches a spreadsheet name to an account. Only a single clear candidate is ever chosen automatically. */
export function matchName(raw: string, candidates: Pick<Candidate, "user_id" | "name" | "email">[]): Match {
  const name = normalizeName(raw);
  if (!name) return { userId: null, confidence: "none", suggestions: [] };
  const people = candidates.map((candidate) => {
    const full = normalizeName(candidate.name);
    const words = full.split(" ").filter(Boolean);
    return { id: candidate.user_id, full, first: words[0] ?? "", last: words[words.length - 1] ?? "", email: candidate.email.toLowerCase() };
  });
  const typed = raw.trim().toLowerCase();
  const exact = people.filter((person) => person.full === name || (typed.includes("@") && person.email === typed));
  if (exact.length === 1) return { userId: exact[0].id, confidence: "exact", suggestions: [exact[0].id] };
  if (exact.length > 1) return { userId: null, confidence: "none", suggestions: exact.map((person) => person.id) };

  const words = name.split(" ");
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : "";
  let likely: typeof people;
  if (last.length > 1) {
    // "Avery Q. Testwood" or "Avery Testwood-Smith" against "Avery Testwood".
    likely = people.filter((person) => person.first === first && (person.last === last || person.full.split(" ").includes(last) || name.split(" ").includes(person.last)));
  } else if (last.length === 1) {
    // "Avery T"
    likely = people.filter((person) => person.first === first && person.last.startsWith(last));
  } else {
    // A first name alone.
    likely = people.filter((person) => person.first === first);
  }
  if (likely.length === 1) return { userId: likely[0].id, confidence: "likely", suggestions: [likely[0].id] };
  const loose = likely.length ? likely : people.filter((person) => person.first === first || (last && person.last === last));
  return { userId: null, confidence: "none", suggestions: loose.slice(0, 8).map((person) => person.id) };
}

/** What the import sends to admin_import_teaching_commitment for one row. */
export type ImportRow = {
  user_id: string | null; label: string; note: string | null;
  cells: { term_id: string; taught: number; assisted: number; hall_monitor: number }[];
};

/**
 * The rows to save: each kept row with its counts placed in the terms the admin mapped the blocks to. `choice` per
 * line is an account id, "label" (keep the name as text) or "skip".
 */
export function importRows(sheet: Extract<ParsedSheet, { ok: true }>, blockTerms: (string | null)[], choice: Record<number, string>): ImportRow[] {
  const out: ImportRow[] = [];
  for (const row of sheet.rows) {
    const picked = choice[row.line] ?? "skip";
    if (picked === "skip") continue;
    const cells = row.counts.flatMap((counts, index) => blockTerms[index] ? [{ term_id: blockTerms[index]!, ...counts }] : []);
    out.push({ user_id: picked === "label" ? null : picked, label: row.name, note: row.note || null, cells });
  }
  return out;
}

// --- the report (CSV and PDF) ----------------------------------------------------------------------------------------------

export type DocOptions = { byHousehold: boolean; people?: CommitmentPerson[] };

/**
 * The tracker as a report document: landscape, one row per adult with Taught / Assisted / Hall for each term, then the
 * totals and the notes. Cells changed by hand carry an asterisk. By household, each household is a section with its
 * total and whether it meets the handbook.
 */
export function buildCommitmentDoc(data: CommitmentData, options: DocOptions): ReportDoc {
  const terms = data.terms ?? [];
  const people = options.people ?? data.people ?? [];
  const settings = data.settings;
  const columns: ReportSection["columns"] = [
    { label: "Name", weight: 1.6 },
    ...(options.byHousehold ? [] : [{ label: "Household", weight: 1.1 }]),
    ...terms.flatMap((term) => ROLES.map((role) => ({ label: `${term.label} ${ROLE_SHORT[role]}`, weight: 0.45 }))),
    { label: "Taught", weight: 0.55 }, { label: "Assisted", weight: 0.6 }, { label: "Hall", weight: 0.45 },
    { label: "Total roles", weight: 0.55 }, { label: "Blocks", weight: 0.5 }, { label: "Notes / classes covered", weight: 3 },
  ];
  const mark = (cell: CommitmentCell) => `${cell.value}${isAdjusted(cell) ? "*" : ""}`;
  const personRow = (person: CommitmentPerson) => [
    `${person.name}${person.heavy ? " (carrying a lot)" : ""}`,
    ...(options.byHousehold ? [] : [person.household_name ?? (person.user_id ? "No household" : "No account")]),
    ...terms.flatMap((term) => ROLES.map((role) => mark(cellOf(person, term.id, role)))),
    String(person.taught), String(person.assisted), String(person.hall_monitor),
    String(person.total_roles), String(person.blocks_participated), coveredText(person, terms),
  ];
  const sorted = [...people].sort((a, b) => b.total_roles - a.total_roles || a.name.localeCompare(b.name));
  const subtitle = `Expectation per household each co-op day: teach ${settings.teach_target}, assist ${settings.assist_target}`
    + `${settings.hall_counts_as_assist ? " (hall monitor counts as assisting)" : ""}. T taught, A assisted, H hall monitor; * changed by hand.`;
  const title = `${data.school_year?.label ?? ""} Teaching Commitment`.trim();

  if (!options.byHousehold) {
    return { title, subtitle, landscape: true, sections: [{ columns, rows: sorted.map(personRow) }] };
  }
  const sections: ReportSection[] = [];
  const households = [...(data.households ?? [])].sort((a, b) => b.total_roles - a.total_roles || a.name.localeCompare(b.name));
  for (const household of households) {
    const members = sorted.filter((person) => person.household_id === household.id);
    const byTerm = new Map((household.terms ?? []).map((term) => [term.term_id, term]));
    const shortIn = terms.filter((term) => { const row = byTerm.get(term.id); return row && row.checked && !row.meets; }).map((term) => term.label);
    sections.push({
      heading: household.name,
      aside: shortIn.length ? `Below the expectation: ${shortIn.join(", ")}` : "Meets the expectation",
      columns,
      rows: [...members.map(personRow), [
        "Household total",
        ...terms.flatMap((term) => ROLES.map((role) => String(byTerm.get(term.id)?.[role] ?? 0))),
        String(household.taught), String(household.assisted), String(household.hall_monitor),
        String(household.total_roles), "", "",
      ]],
    });
  }
  const loose = sorted.filter((person) => !person.household_id || !households.some((household) => household.id === person.household_id));
  if (loose.length) sections.push({ heading: "Not in a household", columns, rows: loose.map(personRow) });
  return { title, subtitle, landscape: true, sections };
}

// --- co-op days and points (migration 20261121100000_coop_days_coverage) ----------------------------------------------

export type ShiftState = {
  user_id: string; owner_name: string; role: CommitmentRole; class_id: string | null; block_id: string | null;
  title: string; period: string | null; released: boolean; cover_id: string | null; covering_user_id: string | null;
  covering_name: string | null; needed: boolean;
};

export type CoopDay = {
  id: string; term_id: string; day: string; cancelled: boolean; note: string | null;
  absences: { id: string; family_id: string | null; user_id: string | null; name: string; reason: string | null }[];
  /** Only the shifts that were released or covered. */ shifts: ShiftState[];
  open_count: number;
};

export type PointsTerm = { term_id: string; earned: number; days_present: number | null; days_absent: number | null; covers_given: number; no_shows: number };
export type PointsPerson = {
  key: string; user_id: string | null; name: string; household_id: string | null; household_name: string | null;
  earned: number; covers_given: number; no_shows: number; days_absent: number; terms: PointsTerm[];
};
export type PointsHouseholdTerm = { term_id: string; days_attended: number; days_away: number; earned: number; expected: number; balance: number };
export type PointsHousehold = { id: string; name: string; terms: PointsHouseholdTerm[] | null; earned: number; expected: number; balance: number };

export type DaysData = {
  school_year: { id: string; label: string; is_current: boolean } | null;
  settings: CommitmentSettings & { teach_points: number; assist_points: number; hall_points: number };
  today: string;
  day_points?: number;
  terms?: (CommitmentTerm & { day_count: number })[];
  households?: PointsHousehold[];
  people?: PointsPerson[];
  days?: CoopDay[];
  families?: { id: string; name: string }[];
  members?: { user_id: string; name: string; household_name: string | null }[];
};

/** "Fri, Nov 20" for a date stored as YYYY-MM-DD (read as a calendar date, never shifted by time zone). */
export function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** What a balance means in plain words, measured in assisting periods (the smallest role). */
export function balanceText(balance: number, assistPoints: number): string {
  if (balance === 0) return "Even";
  const per = Math.max(1, assistPoints);
  const periods = Math.ceil(Math.abs(balance) / per);
  const unit = `${periods} assisting period${periods === 1 ? "" : "s"}`;
  return balance < 0 ? `Behind by ${Math.abs(balance)} (about ${unit})` : `Ahead by ${balance}`;
}

/** Households that should pick up more next block first: the lowest balance, then the fewest points. */
export function byBalance<T extends { balance: number; earned: number; name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.balance - b.balance || a.earned - b.earned || a.name.localeCompare(b.name));
}

/** The Points view as a report: one section per household with its adults, balance per term and for the year. */
export function buildPointsDoc(data: DaysData): ReportDoc {
  const terms = data.terms ?? [];
  const people = data.people ?? [];
  const columns: ReportSection["columns"] = [
    { label: "Household / adult", weight: 1.8 },
    ...terms.flatMap((term) => [{ label: `${term.label} days`, weight: 0.5 }, { label: `${term.label} points`, weight: 0.6 }, { label: `${term.label} balance`, weight: 0.6 }]),
    { label: "Points", weight: 0.6 }, { label: "Expected", weight: 0.6 }, { label: "Balance", weight: 0.6 }, { label: "Covers", weight: 0.5 },
  ];
  const rows: string[][] = [];
  for (const household of byBalance(data.households ?? [])) {
    const byTerm = new Map((household.terms ?? []).map((term) => [term.term_id, term]));
    rows.push([household.name, ...terms.flatMap((term) => { const row = byTerm.get(term.id); return [String(row?.days_attended ?? 0), String(row?.earned ?? 0), String(row?.balance ?? 0)]; }),
      String(household.earned), String(household.expected), String(household.balance), ""]);
    for (const person of people.filter((row) => row.household_id === household.id)) {
      const mine = new Map(person.terms.map((term) => [term.term_id, term]));
      rows.push([`   ${person.name}`, ...terms.flatMap((term) => ["", String(mine.get(term.id)?.earned ?? 0), ""]), String(person.earned), "", "", String(person.covers_given)]);
    }
  }
  for (const person of people.filter((row) => !row.household_id)) {
    const mine = new Map(person.terms.map((term) => [term.term_id, term]));
    rows.push([`${person.name} (no household)`, ...terms.flatMap((term) => ["", String(mine.get(term.id)?.earned ?? 0), ""]), String(person.earned), "", "", String(person.covers_given)]);
  }
  const s = data.settings;
  return {
    title: `${data.school_year?.label ?? ""} Teaching Commitment Points`.trim(),
    subtitle: `Teach ${s.teach_points}, assist ${s.assist_points}, hall monitor ${s.hall_points} points. Expected per co-op day attended: ${data.day_points ?? 0}. Lowest balance first.`,
    landscape: true,
    sections: [{ columns, rows }],
  };
}

/** What a member sees (public.my_coop_days). */
export type MyShift = { role: CommitmentRole; class_id: string | null; block_id: string | null; title: string; period: string | null; starts_at: string | null };
export type MyCoopDay = {
  id: string; day: string; term: string; cancelled: boolean; note: string | null; me_absent: boolean; family_absent: boolean;
  mine: (MyShift & { released: boolean; covering_name: string | null })[];
  open: (MyShift & { owner_id: string; owner_name: string; needed: boolean })[];
  my_covers: { id: string; role: CommitmentRole; title: string; period: string | null; owner_name: string }[];
  loggable: (MyShift & { owner_id: string; owner_name: string })[];
};
export type MyCoopDays = { today: string; household: { id: string; name: string } | null; days: MyCoopDay[] };

/** "Teaching History K-3 (History)", "Assisting Pottery", "Hall monitor (Science)". */
export function shiftLabel(shift: { role: CommitmentRole; title: string; period: string | null }): string {
  const what = shift.role === "taught" ? `Teaching ${shift.title}` : shift.role === "assisted" ? `Assisting ${shift.title}` : "Hall monitor";
  return shift.period ? `${what} (${shift.period})` : what;
}
