// One portal: Family and Teaching share a bar and a flat Menu, Admin stays apart, and saved bars keep working.
// lib/nav-prefs.ts and lib/native-frame.ts are TypeScript, so they are compiled to a temp folder first.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "one-portal-"));
for (const name of ["nav-prefs", "native-frame"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  await writeFile(path.join(dir, `${name}.mjs`), outputText.replace('"./nav-prefs"', '"./nav-prefs.mjs"'));
}
const nav = await import(pathToFileURL(path.join(dir, "nav-prefs.mjs")).href);
const frame = await import(pathToFileURL(path.join(dir, "native-frame.mjs")).href);
const ids = (bar) => bar.map((d) => d.id);

test("a parent assigned a class this year sees Teaching; one who is not does not", () => {
  const parent = ["parent"];
  const teaching = nav.availableDestinations(nav.withTeaching(parent, true)).filter((d) => d.role === "teacher");
  assert.deepEqual(teaching.map((d) => d.id), ["teacher-home", "teacher-news", "teacher-classes", "teacher-lounge"]);
  assert.equal(nav.availableDestinations(nav.withTeaching(parent, false)).some((d) => d.role === "teacher"), false);
  // The teacher role still counts without an assignment, and never adds a role twice.
  assert.equal(nav.availableDestinations(["teacher"]).some((d) => d.id === "teacher-home"), true);
  assert.deepEqual(nav.withTeaching(["teacher"], true), ["teacher"]);
});

test("Admin items exist only for admins, and the Teacher pages share the main bar", () => {
  assert.equal(nav.availableDestinations(nav.withTeaching(["parent"], true)).some((d) => d.area === "admin"), false);
  assert.equal(nav.availableDestinations(["admin"]).some((d) => d.area === "admin"), true);
  assert.equal(nav.sectionOf("teacher"), "home");
  assert.equal(nav.sectionOf("home"), "home");
  assert.equal(nav.sectionOf("admin"), "admin");
});

test("the default bar carries Teaching only for people who teach", () => {
  assert.deepEqual(ids(nav.resolveBar({}, "home", ["parent"])), ["home", "photos", "messages"]);
  assert.deepEqual(ids(nav.resolveBar({}, "home", nav.withTeaching(["parent"], true))), ["home", "teacher-home", "photos", "messages"]);
});

test("saved bars: the old Home and Teacher bars merge, without repeats, capped at five", () => {
  const merged = nav.cleanPrefs({ home: ["home", "photos", "messages"], teacher: ["home", "teacher-home", "photos", "teacher-classes", "calendar"], admin: ["admin-dashboard"] });
  assert.deepEqual(merged.home, ["home", "photos", "messages", "teacher-home", "teacher-classes"]);
  assert.equal(merged.teacher, undefined, "the old Teacher bar is not carried forward");
  assert.deepEqual(merged.admin, ["admin-dashboard"]);
  // Nothing is lost: both original lists stay on file, and what was squeezed out is still in the Menu.
  assert.deepEqual(merged.legacy.home, ["home", "photos", "messages"]);
  assert.deepEqual(merged.legacy.teacher, ["home", "teacher-home", "photos", "teacher-classes", "calendar"]);
  assert.equal(nav.availableDestinations(["teacher"]).some((d) => d.id === "calendar"), true);
  // Merging is stable: already-merged prefs come back the same.
  assert.deepEqual(nav.cleanPrefs(JSON.parse(JSON.stringify(merged))), merged);
});

test("saved bars: only one old list, renamed ids, junk and unknown ids", () => {
  assert.deepEqual(nav.cleanPrefs({ teacher: ["home", "teacher-home", "paperwork"] }).home, ["home", "teacher-home", "documents"]);
  assert.deepEqual(nav.cleanPrefs({ home: ["news", "news", 7, "nope", "paperwork"] }).home, ["news", "documents"]);
  for (const junk of [null, undefined, "x", 5, [], { home: "x" }, { home: [null] }]) assert.doesNotThrow(() => nav.cleanPrefs(junk));
  assert.deepEqual(nav.cleanPrefs({ home: "x" }), {});
});

test("a merged bar never shows items the person may not use (a teacher who stopped teaching)", () => {
  const prefs = nav.cleanPrefs({ home: ["home", "photos"], teacher: ["teacher-home", "teacher-classes"] });
  assert.deepEqual(ids(nav.resolveBar(prefs, "home", ["parent"])), ["home", "photos"]);
  assert.deepEqual(ids(nav.resolveBar(prefs, "home", ["teacher"])), ["home", "photos", "teacher-home", "teacher-classes"]);
  // With nothing usable left, the default bar steps in.
  assert.deepEqual(ids(nav.resolveBar({ home: ["teacher-home"] }, "home", ["parent"])), ["home", "photos", "messages"]);
});

test("the frame's state: one flat Menu with Admin set apart, same message shape as before", () => {
  const state = frame.buildFrameState({ prefs: {}, roles: nav.withTeaching(["parent", "admin"], true), unread: 3 });
  assert.equal(state.unread, 3);
  assert.equal(state.home, "/family-village/home");
  assert.deepEqual(state.menu.map((g) => g.title), ["", "Admin"]);
  const flat = state.menu[0].items.map((i) => i.id);
  assert.ok(["calendar", "photos", "messages", "teacher-home"].every((id) => flat.includes(id)), "Family and Teaching items sit together");
  assert.ok(state.menu[1].items.every((i) => i.id.startsWith("admin-")));
  for (const item of state.menu.flatMap((g) => g.items)) assert.deepEqual(Object.keys(item).sort(), ["href", "icon", "id", "label"]);
  const parentOnly = frame.buildFrameState({ prefs: {}, roles: ["parent"], unread: 0 });
  assert.deepEqual(parentOnly.menu.map((g) => g.title), [""]);
  assert.equal(JSON.stringify(state).includes("Anywhere in the portal"), false);
});

test("no 'Anywhere in the portal' or 'Everywhere' group is left in the interface", async () => {
  for (const file of ["lib/nav-prefs.ts", "lib/native-frame.ts", "app/family-village/app-tab-bar.tsx", "app/family-village/portal-menu-items.tsx", "app/family-village/bar-customizer.tsx"]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /Anywhere in the portal|"Everywhere"/, file);
  }
});
