/// <reference lib="deno.ns" />
// Every name here is made up.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildCommitmentDoc, cellOf, coveredText, importRows, isAdjusted, matchName, normalizeName, parseCommitmentSheet, parseCsv,
  shortfall, type CommitmentData, type CommitmentPerson,
} from "./teaching-commitment.ts";

// The spreadsheet's layout, as Google Sheets or Excel exports it to CSV: title rows, a two-row header with each Block
// over three columns (merged cells come out as a label and blanks), totals, notes, then blank rows, zero rows and a
// totals row.
const SHEET = [
  "Teaching Commitment 2090-91,,,,,,,,,,,,,,,,,,",
  "Updated weekly,,,,,,,,,,,,,,,,,,",
  ",,,,,,,,,,,,,,,,,,",
  "Name,Block 1,,,Block 2,,,Block 3,,,Block 4,,,Total Taught,Total Assisted,Total Hall Monitor,Total roles,Blocks participated,Notes / classes covered",
  ",Taught,Assisted,Hall Monitor,Taught,Assisted,Hall Monitor,Taught,Assisted,Hall Monitor,Taught,Assisted,Hall Monitor,,,,,,",
  "Avery Testwood,1,2,0,1,1,,1,2,0,0,0,0,3,5,0,8,3,\"History K-3, Pottery\"",
  "Blake Testwood,0,0,1,0,2,0,,,,,,,0,2,1,3,2,",
  ",,,,,,,,,,,,,,,,,,",
  "Casey Sampleford,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,",
  "  Drew   Exampleton ,2,x,0,0,0,0,0,0,0,0,0,0,2,0,0,9,1,Chess",
  "Totals,3,2,1,1,3,0,1,2,0,0,0,0,,,,,,",
].join("\r\n");

Deno.test("parseCsv: quotes, doubled quotes, line breaks inside quotes, CRLF and a BOM", () => {
  assertEquals(parseCsv('\uFEFFa,"b, c","say ""hi"""\r\n"two\nlines",x\n'), [["a", "b, c", 'say "hi"'], ["two\nlines", "x"]]);
  assertEquals(parseCsv("a,b\rc,d"), [["a", "b"], ["c", "d"]]);
});

Deno.test("parseCommitmentSheet: finds the header under the title rows and the four blocks", () => {
  const sheet = parseCommitmentSheet(SHEET);
  assert(sheet.ok);
  assertEquals(sheet.blocks.map((block) => block.label), ["Block 1", "Block 2", "Block 3", "Block 4"]);
  assertEquals(sheet.blocks[1].columns, { taught: 4, assisted: 5, hall_monitor: 6 });
});

Deno.test("parseCommitmentSheet: reads counts, treats blanks as 0 and keeps the notes", () => {
  const sheet = parseCommitmentSheet(SHEET);
  assert(sheet.ok);
  const [avery, blake] = sheet.rows;
  assertEquals(avery.name, "Avery Testwood");
  assertEquals(avery.counts[0], { taught: 1, assisted: 2, hall_monitor: 0 });
  assertEquals(avery.total, 8);
  assertEquals(avery.note, "History K-3, Pottery");
  assertEquals(avery.warnings, []);
  assertEquals(blake.counts[2], { taught: 0, assisted: 0, hall_monitor: 0 });
  assertEquals(blake.total, 3);
});

Deno.test("parseCommitmentSheet: skips blank rows, rows of zeros and the totals row", () => {
  const sheet = parseCommitmentSheet(SHEET);
  assert(sheet.ok);
  assertEquals(sheet.rows.map((row) => row.name), ["Avery Testwood", "Blake Testwood", "Drew Exampleton"]);
  assertEquals(sheet.skipped.map((row) => `${row.line}:${row.why}`), ["8:blank", "9:zero", "11:totals"]);
  assertEquals(sheet.skipped.find((row) => row.why === "zero")?.name, "Casey Sampleford");
  assertEquals(sheet.warnings, []);
});

Deno.test("parseCommitmentSheet: a value that is not a count is read as 0 with a warning, and totals are checked", () => {
  const sheet = parseCommitmentSheet(SHEET);
  assert(sheet.ok);
  const drew = sheet.rows[2];
  assertEquals(drew.name, "Drew Exampleton", "spaces are tidied");
  assertEquals(drew.counts[0], { taught: 2, assisted: 0, hall_monitor: 0 });
  assertEquals(drew.warnings.length, 2);
  assertStringIncludes(drew.warnings[0], 'Block 1 Assisted "x"');
  assertStringIncludes(drew.warnings[1], "Total roles is 9");
});

Deno.test("parseCommitmentSheet: a row with counts but no name is skipped, with a warning", () => {
  const sheet = parseCommitmentSheet([
    "Name,Block 1,,", ",Taught,Assisted,Hall Monitor", ",1,0,0", "Robin Placeholder,0,1,0",
  ].join("\n"));
  assert(sheet.ok);
  assertEquals(sheet.rows.length, 1);
  assertEquals(sheet.skipped[0].why, "blank");
  assertStringIncludes(sheet.warnings[0], "Line 3 has counts but no name");
});

Deno.test("parseCommitmentSheet: refuses files in another layout", () => {
  const wrong = parseCommitmentSheet("Household,Amount\nTestwood,300\n");
  assertFalse(wrong.ok);
  const missing = parseCommitmentSheet("Name,Block 1,\n,Taught,Assisted\nAvery,1,1\n");
  assertFalse(missing.ok);
  if (!missing.ok) assertStringIncludes(missing.error, "Block 1 is missing");
  assertFalse(parseCommitmentSheet("").ok);
});

Deno.test("parseCommitmentSheet: an empty spreadsheet (header only) has no rows", () => {
  const sheet = parseCommitmentSheet("Name,Block 1,,\n,Taught,Assisted,Hall Monitor\n,,,\n");
  assert(sheet.ok);
  assertEquals(sheet.rows, []);
});

const CANDIDATES = [
  { user_id: "u1", name: "Avery Testwood", email: "avery@example.com" },
  { user_id: "u2", name: "Blake Testwood", email: "blake@example.com" },
  { user_id: "u3", name: "Avery Sampleford", email: "a.sampleford@example.com" },
  { user_id: "u4", name: "Renée Exampleton", email: "renee@example.com" },
  { user_id: "u5", name: "Drew Exampleton", email: "drew@example.com" },
];

Deno.test("normalizeName: case, accents, punctuation and spacing do not matter", () => {
  assertEquals(normalizeName("  RENÉE  O'Exampleton-Smith "), "renee oexampleton smith");
  assertEquals(normalizeName("Avery Testwood (sub)"), "avery testwood");
});

Deno.test("matchName: an exact full name is matched", () => {
  assertEquals(matchName("avery testwood", CANDIDATES), { userId: "u1", confidence: "exact", suggestions: ["u1"] });
  assertEquals(matchName("Renee Exampleton", CANDIDATES).userId, "u4");
  assertEquals(matchName("drew@example.com", CANDIDATES).userId, "u5");
});

Deno.test("matchName: a looser match to one account is offered as likely", () => {
  assertEquals(matchName("Blake T.", CANDIDATES), { userId: "u2", confidence: "likely", suggestions: ["u2"] });
  assertEquals(matchName("Drew", CANDIDATES).confidence, "likely");
  assertEquals(matchName("Avery Q Testwood", CANDIDATES).userId, "u1");
});

Deno.test("matchName: two possible accounts are never chosen automatically", () => {
  const avery = matchName("Avery", CANDIDATES);
  assertEquals(avery.userId, null);
  assertEquals(avery.confidence, "none");
  assertEquals(avery.suggestions.sort(), ["u1", "u3"]);
  assertEquals(matchName("Jordan Nobody", CANDIDATES).userId, null);
  assertEquals(matchName("", CANDIDATES).suggestions, []);
});

Deno.test("importRows: places each block's counts in the mapped term, keeps names as text, drops skipped rows", () => {
  const sheet = parseCommitmentSheet(SHEET);
  assert(sheet.ok);
  const rows = importRows(sheet, ["t1", "t2", null, null], { 6: "u1", 7: "label" });
  assertEquals(rows.length, 2, "Drew's row was not chosen, so it is skipped");
  assertEquals(rows[0], {
    user_id: "u1", label: "Avery Testwood", note: "History K-3, Pottery",
    cells: [{ term_id: "t1", taught: 1, assisted: 2, hall_monitor: 0 }, { term_id: "t2", taught: 1, assisted: 1, hall_monitor: 0 }],
  });
  assertEquals(rows[1].user_id, null);
  assertEquals(rows[1].note, null);
});

const person = (over: Partial<CommitmentPerson>): CommitmentPerson => ({
  key: "u1", user_id: "u1", label: null, name: "Avery Testwood", household_id: "h1", household_name: "Testwood",
  taught: 1, assisted: 2, hall_monitor: 0, total_roles: 3, blocks_participated: 1, max_term_roles: 3, heavy: false, note: null,
  cells: [
    { term_id: "t1", role: "taught", auto: 1, set: null, adjust: 0, value: 1 },
    { term_id: "t1", role: "assisted", auto: 1, set: null, adjust: 1, value: 2 },
  ],
  classes: [{ term_id: "t1", title: "History K-3", role: "taught" }, { term_id: "t1", title: "Pottery", role: "assisted" }],
  hall: [{ term_id: "t1", block_id: "b2" }],
  ...over,
});

const DATA: CommitmentData = {
  school_year: { id: "y", label: "2090-91", is_current: true },
  years: [],
  settings: { teach_target: 1, assist_target: 2, hall_counts_as_assist: true, heavy_load: 4 },
  terms: [{ id: "t1", label: "Fall A", starts_on: "2090-09-01", ends_on: "2090-10-15", checked: true },
    { id: "t2", label: "Fall B", starts_on: "2090-10-20", ends_on: "2090-12-15", checked: true }],
  people: [
    person({}),
    person({ key: "u2", user_id: "u2", name: "Blake Testwood", total_roles: 5, heavy: true, cells: [], classes: [], hall: [] }),
    person({ key: "label:robin", user_id: null, label: "Robin Placeholder", name: "Robin Placeholder", household_id: null,
      household_name: null, total_roles: 1, cells: [], classes: [], hall: [], note: "From the sheet" }),
  ],
  households: [{
    id: "h1", name: "Testwood", taught: 1, assisted: 2, hall_monitor: 0, total_roles: 8, short_terms: 1, meets: false,
    terms: [{ term_id: "t1", taught: 1, assisted: 2, hall_monitor: 0, checked: true, meets: true },
      { term_id: "t2", taught: 0, assisted: 1, hall_monitor: 0, checked: true, meets: false }],
  }],
};

Deno.test("cells: missing cells read as 0; set or adjusted cells are marked", () => {
  const avery = DATA.people![0];
  assertEquals(cellOf(avery, "t2", "taught").value, 0);
  assertFalse(isAdjusted(cellOf(avery, "t1", "taught")));
  assert(isAdjusted(cellOf(avery, "t1", "assisted")));
  assert(isAdjusted({ term_id: "t1", role: "taught", auto: 0, set: 0, adjust: 0, value: 0 }));
});

Deno.test("coveredText: the note, then the classes and hall periods per term", () => {
  assertEquals(coveredText(person({ note: "Covers for Blake" }), DATA.terms!),
    "Covers for Blake — Fall A: History K-3, Pottery (assisted), hall monitor 1 period");
});

Deno.test("shortfall: says what a household still needs, counting hall monitor as assisting when set", () => {
  const settings = DATA.settings;
  assertEquals(shortfall({ term_id: "t2", taught: 0, assisted: 1, hall_monitor: 0, checked: true, meets: false }, settings), "teach 1 more, assist 1 more");
  assertEquals(shortfall({ term_id: "t2", taught: 1, assisted: 0, hall_monitor: 1, checked: true, meets: false }, settings), "assist 1 more");
  assertEquals(shortfall({ term_id: "t2", taught: 1, assisted: 0, hall_monitor: 1, checked: true, meets: false }, { ...settings, hall_counts_as_assist: false }), "assist 2 more");
  assertEquals(shortfall({ term_id: "t2", taught: 0, assisted: 0, hall_monitor: 0, checked: false, meets: false }, settings), "");
});

Deno.test("buildCommitmentDoc: everyone, sorted by total roles, landscape, three columns per term", () => {
  const doc = buildCommitmentDoc(DATA, { byHousehold: false });
  assert(doc.landscape);
  assertEquals(doc.title, "2090-91 Teaching Commitment");
  const [section] = doc.sections;
  assertEquals(section.columns.length, 2 + 6 + 6);
  assertEquals(section.columns[2].label, "Fall A T");
  assertEquals(section.rows.map((row) => row[0]), ["Blake Testwood (carrying a lot)", "Avery Testwood", "Robin Placeholder"]);
  assertEquals(section.rows[1].slice(2, 5), ["1", "2*", "0"]);
  assertEquals(section.rows[2][1], "No account");
});

Deno.test("buildCommitmentDoc: by household, with the household total and whether it meets the handbook", () => {
  const doc = buildCommitmentDoc(DATA, { byHousehold: true });
  assertEquals(doc.sections.map((section) => section.heading), ["Testwood", "Not in a household"]);
  const [testwood] = doc.sections;
  assertEquals(testwood.aside, "Below the expectation: Fall B");
  const total = testwood.rows[testwood.rows.length - 1];
  assertEquals(total[0], "Household total");
  assertEquals(total.slice(1, 7), ["1", "2", "0", "0", "1", "0"]);
  assertEquals(total.length, testwood.columns.length);
});

import { balanceText, buildPointsDoc, byBalance, dayLabel, shiftLabel, type DaysData } from "./teaching-commitment.ts";

Deno.test("dayLabel: a stored date reads as that calendar day", () => {
  assertEquals(dayLabel("2090-11-17"), "Fri, Nov 17");
});

Deno.test("balanceText: behind is measured in assisting periods", () => {
  assertEquals(balanceText(0, 1), "Even");
  assertEquals(balanceText(-6, 1), "Behind by 6 (about 6 assisting periods)");
  assertEquals(balanceText(-3, 2), "Behind by 3 (about 2 assisting periods)");
  assertEquals(balanceText(4, 1), "Ahead by 4");
});

Deno.test("byBalance: the household furthest behind comes first", () => {
  const rows = byBalance([{ name: "B", balance: -2, earned: 6 }, { name: "A", balance: 3, earned: 9 }, { name: "C", balance: -6, earned: 6 }]);
  assertEquals(rows.map((row) => row.name), ["C", "B", "A"]);
});

Deno.test("shiftLabel", () => {
  assertEquals(shiftLabel({ role: "taught", title: "History K-3", period: "History" }), "Teaching History K-3 (History)");
  assertEquals(shiftLabel({ role: "hall_monitor", title: "Hall monitor", period: "Science" }), "Hall monitor (Science)");
});

Deno.test("buildPointsDoc: households by balance, with their adults beneath", () => {
  const data: DaysData = {
    school_year: { id: "y", label: "2090-91", is_current: true },
    settings: { teach_target: 1, assist_target: 2, hall_counts_as_assist: true, heavy_load: 4, teach_points: 2, assist_points: 1, hall_points: 1 },
    today: "2090-11-20", day_points: 4,
    terms: [{ id: "t1", label: "Block 1", starts_on: "", ends_on: "", checked: true, day_count: 3 }],
    households: [
      { id: "h2", name: "Sampleford", earned: 6, expected: 8, balance: -2, terms: [{ term_id: "t1", days_attended: 2, days_away: 1, earned: 6, expected: 8, balance: -2 }] },
      { id: "h1", name: "Testwood", earned: 6, expected: 12, balance: -6, terms: [{ term_id: "t1", days_attended: 3, days_away: 0, earned: 6, expected: 12, balance: -6 }] },
    ],
    people: [
      { key: "u1", user_id: "u1", name: "Avery Testwood", household_id: "h1", household_name: "Testwood", earned: 4, covers_given: 0, no_shows: 0, days_absent: 1, terms: [{ term_id: "t1", earned: 4, days_present: 2, days_absent: 1, covers_given: 0, no_shows: 0 }] },
      { key: "u4", user_id: "u4", name: "Drew Exampleton", household_id: null, household_name: null, earned: 6, covers_given: 2, no_shows: 0, days_absent: 0, terms: [{ term_id: "t1", earned: 6, days_present: 3, days_absent: 0, covers_given: 2, no_shows: 0 }] },
    ],
  };
  const doc = buildPointsDoc(data);
  const rows = doc.sections[0].rows;
  assertEquals(rows.map((row) => row[0]), ["Testwood", "   Avery Testwood", "Sampleford", "Drew Exampleton (no household)"]);
  assertEquals(rows[0].slice(1), ["3", "6", "-6", "6", "12", "-6", ""]);
  assertEquals(rows[0].length, doc.sections[0].columns.length);
  assert(doc.landscape);
});
