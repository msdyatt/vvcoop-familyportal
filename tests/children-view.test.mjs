// Children screens: the next co-op day on a Today card, assignments due, and the enrollment picker's rules
// (lib/children-view.ts), plus where the pieces live now that the family screens no longer open ChildDetail.
// lib/*.ts is TypeScript, so it is compiled to a temp folder first.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "children-view-"));
for (const name of ["schedule", "children-view"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(dir, `${name}.mjs`), outputText.replace('"./schedule"', '"./schedule.mjs"'));
}
const view = await import(pathToFileURL(path.join(dir, "children-view.mjs")).href);
const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

// Wednesday 25 November 2026, local time. Co-op days are Fridays.
const WED = new Date(2026, 10, 25, 9, 0);
const FRIDAY = 5;
const block = (start, end, day = FRIDAY) => ({ label: "", starts_at: start, ends_at: end, day_of_week: day });
const raw = (id, title, start, extra = {}) => ({
  id, title, class_blocks: block(start, start.replace(":00:00", ":50:00")), rooms: null,
  class_terms: [], teacher_assignments: [], ...extra,
});
const date = (id, day, prework, classId = "art") => ({ id, title: `Topic ${id}`, day, location: null, requiresPrework: prework, classId, classTitle: classId, completed: false });

test("a card shows the next co-op day's classes in time order, with History at 10 before Science at 11", () => {
  const classes = [
    raw("sci", "Science", "11:00:00"),
    raw("art", "Art", "13:00:00"),
    raw("his", "History", "10:00:00"),
    raw("chess", "Chess", "14:00:00", { class_blocks: block("14:00:00", "14:50:00", 2) }), // a Tuesday club
  ].map((row) => view.toChildClass(row, WED));
  const next = view.nextCoopDay(classes, [], "2026-11-25");
  assert.equal(next.day, "2026-11-27");
  assert.deepEqual(next.classes.map((row) => row.title), ["History", "Science", "Art"]);
  assert.equal(view.classStartLabel(next.classes[0]), "10:00 AM");
  assert.equal(view.formatCoopDay("2026-11-27"), "Friday, Nov 27");
});

test("a Friday is its own next co-op day, so the card does not skip ahead on the morning of co-op", () => {
  const friday = new Date(2026, 10, 27, 8, 0);
  const classes = [view.toChildClass(raw("his", "History", "10:00:00"), friday)];
  assert.equal(view.nextCoopDay(classes, [], "2026-11-27").day, "2026-11-27");
});

test("assignments due by the next co-op day show on the card; later ones and plain topics do not", () => {
  const classes = [view.toChildClass(raw("art", "Art", "13:00:00"), WED)];
  const dates = [date("a", "2026-11-27", true), date("b", "2026-11-27", false), date("c", "2026-12-04", true), date("old", "2026-11-20", true)];
  assert.deepEqual(view.nextCoopDay(classes, dates, "2026-11-25").assignments.map((row) => row.id), ["a"]);
});

test("with no meeting ahead, the next few assignments still show, and a child with no classes has no day", () => {
  const over = view.toChildClass(raw("art", "Art", "13:00:00", { class_terms: [{ academic_terms: { starts_on: "2026-08-24", ends_on: "2026-11-13" } }] }), WED);
  assert.equal(over.nextMeeting, null);
  const dates = ["1", "2", "3", "4"].map((n) => date(n, `2026-12-0${n}`, true));
  const next = view.nextCoopDay([over], dates, "2026-11-25");
  assert.equal(next.day, null);
  assert.deepEqual(next.classes, []);
  assert.deepEqual(next.assignments.map((row) => row.id), ["1", "2", "3"]);
  assert.equal(view.nextCoopDay([], [], "2026-11-25").day, null);
});

test("teachers: lead first, the card names the lead, and nameless rows are dropped", () => {
  const row = view.toChildClass(raw("his", "History", "10:00:00", { teacher_assignments: [
    { user_id: "a", assignment_role: "assistant", profiles: { display_name: "Pat Helper", email: "pat@example.com" } },
    { user_id: "l", assignment_role: "lead", profiles: { display_name: null, email: "lee@example.com" } },
    { user_id: "x", assignment_role: "assistant", profiles: null },
  ] }), WED);
  assert.deepEqual(row.teachers.map((teacher) => teacher.id), ["l", "a"]);
  assert.equal(view.teacherLine(row.teachers), "lee@example.com");
  assert.equal(view.teacherLine(row.teachers.filter((teacher) => teacher.role !== "lead")), "Pat Helper");
});

test("enrollable classes: grade matches (empty means any), not already in, term not over; no grade means nothing", () => {
  const rows = [
    { id: "any", title: "Any", description: null, is_elective: true, grades: [], class_terms: [] },
    { id: "g3", title: "Third", description: null, is_elective: true, grades: ["3"], class_terms: [] },
    { id: "g5", title: "Fifth", description: null, is_elective: true, grades: ["5"], class_terms: [] },
    { id: "mine", title: "Mine", description: null, is_elective: true, grades: [], class_terms: [] },
    { id: "over", title: "Over", description: null, is_elective: true, grades: [], class_terms: [{ academic_terms: { starts_on: "2026-08-01", ends_on: "2026-11-01" } }] },
    { id: "spring", title: "Spring", description: null, is_elective: true, grades: [], class_terms: [{ academic_terms: { starts_on: "2027-01-11", ends_on: "2027-05-14" } }] },
  ];
  const ids = view.matchEnrollable(rows, "3", new Set(["mine"]), "2026-11-25").map((row) => row.id);
  assert.deepEqual(ids, ["any", "g3", "spring"]);
  assert.deepEqual(view.matchEnrollable(rows, null, new Set(), "2026-11-25"), []);
});

test("full and prerequisite locks keep their messages and cannot be picked", () => {
  const base = { id: "x", title: "X", description: null, is_elective: true, grades: [], class_terms: [], class_blocks: block("13:00:00", "13:50:00"), rooms: null };
  const full = view.toEnrollOption(base, { is_full: true, missing_prerequisites: null });
  const prereq = view.toEnrollOption({ ...base, id: "y" }, { is_full: false, missing_prerequisites: ["Art 1", "Art 2"] });
  const open = view.toEnrollOption({ ...base, id: "z" }, undefined);
  assert.equal(view.lockReason(full), "Class full");
  assert.equal(view.lockReason(prereq), "Requires Art 1, Art 2 first");
  assert.equal(view.lockReason(open), null);
  assert.deepEqual(view.togglePick([], full, [full, prereq, open]), []);
  assert.deepEqual(view.togglePick([], prereq, [full, prereq, open]), []);
});

test("picking: one class per time slot, unticking works, and classes at different times add up", () => {
  const make = (id, start) => view.toEnrollOption({ id, title: id, description: null, is_elective: true, grades: [], class_terms: [], class_blocks: block(start, "15:00:00"), rooms: null }, undefined);
  const art = make("art", "13:00:00");
  const drama = make("drama", "13:00:00");
  const chess = make("chess", "14:00:00");
  const all = [art, drama, chess];
  let picks = view.togglePick([], art, all);
  picks = view.togglePick(picks, chess, all);
  assert.deepEqual(picks, ["art", "chess"]);
  picks = view.togglePick(picks, drama, all);
  assert.deepEqual(picks, ["chess", "drama"], "drama replaces art at 1:00");
  assert.deepEqual(view.togglePick(picks, chess, all), ["drama"]);
  // A class with no block yet does not knock anything out.
  const loose = view.toEnrollOption({ id: "loose", title: "loose", description: null, is_elective: true, grades: [], class_terms: [], class_blocks: null, rooms: null }, undefined);
  assert.equal(loose.blockKey, null);
  assert.deepEqual(view.togglePick(["drama"], loose, [...all, loose]), ["drama", "loose"]);
});

test("families no longer open ChildDetail; Admin, Families still does, through the shared loader", async () => {
  const gate = await read("app/family-village/home/portal-gate.tsx");
  assert.doesNotMatch(gate, /child-detail/);
  assert.match(gate, /useChildren\(/);
  assert.match(gate, /<ChildCard /);
  assert.match(gate, /<ChildrenSections /);
  assert.match(gate, /<p className="eyebrow">Your family<\/p><h2>Children<\/h2>/, "the Children page keeps its heading and eyebrow");
  const admin = await read("app/family-village/admin/families-tab.tsx");
  assert.match(admin, /import ChildDetail from "\.\.\/child-detail"/);
  const detail = await read("app/family-village/child-detail.tsx");
  assert.match(detail, /useChildren\(\[childId\]\)/);
  // Assignment ticks write the same rows as before: one event_completions row per event and child.
  const hook = await read("app/family-village/children/use-children.ts");
  assert.match(hook, /from\("event_completions"\)\.delete\(\)\.eq\("event_id", eventId\)\.eq\("child_id", childId\)/);
  assert.match(hook, /from\("event_completions"\)\.insert\(\{ event_id: eventId, child_id: childId, completed_by:/);
  assert.match(hook, /rpc\("family_enrollment_options"/);
  assert.match(hook, /rpc\("family_self_enroll"/);
});

test("the children stylesheet uses role tokens only and loads before Messages' desktop sheet", async () => {
  const css = (await read("app/children.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hex colours");
  assert.doesNotMatch(css, /rgba?\(\s*\d/, "no literal rgb() colours");
  assert.doesNotMatch(css, /var\(--(navy|terracotta|sage|antique-gold)\)/, "no brand colours for a role");
  const layout = await read("app/layout.tsx");
  const imports = [...layout.matchAll(/^import "\.\/([^"]+\.css)";$/gm)].map((m) => m[1]);
  assert.ok(imports.indexOf("children.css") > imports.indexOf("page-layout.css"));
  assert.equal(imports.at(-1), "messages-desktop.css");
});
