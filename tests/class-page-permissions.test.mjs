// Who gets the teacher's controls on a class page. A parent, even one who is also an administrator, sees their own
// child's class as a parent does; the class's teachers (and an administrator with no link to the class) manage it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "class-perms-"));
const compile = async (from, to, swap = {}) => {
  let text = ts.transpileModule(await readFile(new URL(`../${from}`, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [a, b] of Object.entries(swap)) text = text.replace(a, b);
  await writeFile(path.join(dir, to), text);
};
await compile("lib/schedule.ts", "schedule.mjs");
await compile("app/family-village/classes/class-data.ts", "class-data.mjs", { '"../../../lib/schedule"': '"./schedule.mjs"' });
const { loadClassPage } = await import(pathToFileURL(path.join(dir, "class-data.mjs")).href);

const CLASS = "c1";
const classRow = { id: CLASS, title: "Latin", description: null, grades: ["3"], is_elective: false, capacity: null, active: true, school_year_id: "y1", class_blocks: null, rooms: null, class_terms: [] };

/** A stand-in for the signed-in session: answers each table with fixed rows and ignores filters. */
function fakeSupabase({ teachers = [], enrolled = [], familyOf = [] }) {
  const tables = {
    classes: classRow,
    teacher_assignments: teachers.map((t) => ({ class_id: CLASS, assignment_role: t.role, user_id: t.id, profiles: { display_name: t.id, email: "" } })),
    enrollments: enrolled.map((c) => ({ child_id: c, children: { id: c, first_name: c, last_name: null, age_band: null, avatar_path: null } })),
    family_members: familyOf.length ? [{ family_id: "f1" }] : [],
    children: familyOf.map((id) => ({ id })),
    documents: [], events: [], conversations: [], event_completions: [],
  };
  return { from(table) {
    const rows = tables[table] ?? [];
    const query = { select: () => query, eq: () => query, in: () => query, order: () => query, limit: () => query,
      maybeSingle: () => Promise.resolve({ data: Array.isArray(rows) ? rows[0] ?? null : rows }),
      then: (resolve) => resolve({ data: Array.isArray(rows) ? rows : [rows] }) };
    return query;
  } };
}
const view = (opts, roles = ["parent"]) => loadClassPage(fakeSupabase(opts), "me", CLASS, roles);
const parentOf = { enrolled: ["mine", "other"], familyOf: ["mine"] };

test("a parent is a parent: no team powers, sees only their own child", async () => {
  const data = await view(parentOf);
  assert.deepEqual([data.isLead, data.isAssistant, data.isAdmin], [false, false, false]);
  assert.deepEqual(data.roster.map((p) => p.id), ["mine"]);
});

test("an administrator who is a parent of the class sees it as a parent does", async () => {
  const data = await view(parentOf, ["parent", "admin"]);
  assert.deepEqual([data.isLead, data.isAssistant, data.isAdmin], [false, false, false]);
  assert.deepEqual(data.roster.map((p) => p.id), ["mine"], "other families' children stay hidden");
});

test("the class's teachers keep their powers, whatever else they are", async () => {
  const lead = await view({ ...parentOf, teachers: [{ id: "me", role: "lead" }] });
  assert.equal(lead.isLead, true);
  assert.deepEqual(lead.roster.map((p) => p.id).sort(), ["mine", "other"]);
  const assistant = await view({ ...parentOf, teachers: [{ id: "me", role: "assistant" }] }, ["parent", "admin"]);
  assert.deepEqual([assistant.isLead, assistant.isAssistant, assistant.isAdmin], [false, true, false], "an assistant manages nothing the lead does not hand over");
});

test("an administrator with no link to the class still oversees it; a stranger sees nothing", async () => {
  const admin = await view({ enrolled: ["other"] }, ["admin"]);
  assert.equal(admin.isAdmin, true);
  assert.deepEqual(admin.roster.map((p) => p.id), ["other"]);
  assert.equal(await view({ enrolled: ["other"] }), null);
});
