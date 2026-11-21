// The records vault screens (lib/records-vault.ts, app/family-village/admin/records-vault-tab.tsx): the browser's
// checks match the database's, files go only to the path the storage policy accepts, every read goes through the
// logged open step, and the tab is registered. The TypeScript is compiled to a temp folder first.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const dir = await mkdtemp(path.join(tmpdir(), "records-vault-"));
const source = await readFile(new URL("../lib/records-vault.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
await writeFile(path.join(dir, "records-vault.mjs"), outputText);
const vault = await import(pathToFileURL(path.join(dir, "records-vault.mjs")).href);
const migration = await readFile(new URL("../supabase/migrations/20261114110000_records_vault.sql", import.meta.url), "utf8");
const tab = await readFile(new URL("../app/family-village/admin/records-vault-tab.tsx", import.meta.url), "utf8");

test("categories and file types are the ones the database allows", () => {
  const categories = migration.match(/category in \(([^)]*)\)/)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(vault.RECORD_CATEGORIES.map((c) => c.id), categories);
  const types = migration.match(/content_type in \(([^)]*)\)/)[1].match(/'([a-z/]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(Object.keys(vault.RECORD_FILE_TYPES).sort(), types.sort());
  assert.equal(vault.RECORD_FILE_MAX_BYTES, 20971520);
  assert.equal(vault.sensitiveByDefault("tax"), true);
  assert.equal(vault.sensitiveByDefault("insurance"), false);
});

test("a file goes to records/<record>/<file>.<ext>, the shape the storage policy accepts", () => {
  const policy = new RegExp(migration.match(/name ~ '(\^records\/[^']+)'/)[1]);
  const record = "6f1c2b9e-1111-4a4a-9c9c-123456789abc", file = "0d3e4f5a-2222-4b4b-8d8d-abcdefabcdef";
  for (const type of Object.keys(vault.RECORD_FILE_TYPES)) assert.match(vault.recordFilePath(record, file, type), policy);
  assert.equal(vault.recordFilePath(record, file, "application/pdf"), `records/${record}/${file}.pdf`);
  assert.throws(() => vault.recordFilePath(record, file, "image/heic"));
});

test("files the vault refuses are refused before upload", () => {
  assert.equal(vault.recordFileProblem({ type: "application/pdf", size: 1000 }), null);
  assert.match(vault.recordFileProblem({ type: "image/heic", size: 1000 }), /PDF or a photo/);
  assert.match(vault.recordFileProblem({ type: "image/png", size: 0 }), /empty/);
  assert.match(vault.recordFileProblem({ type: "image/png", size: 20971521 }), /20 MB/);
});

test("the SHA-256 is lowercase hex, as the database checks", async () => {
  const hex = await vault.sha256Hex(new TextEncoder().encode("abc").buffer);
  assert.equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(hex, /^[0-9a-f]{64}$/);
});

test("tags are tidied like private.clean_record_tags", () => {
  assert.deepEqual(vault.parseTags(" Fire, liability ,fire,, "), ["fire", "liability"]);
  assert.equal(vault.parseTags("x".repeat(50))[0].length, 40);
  assert.deepEqual(vault.parseTags(""), []);
});

test("expiry reads in days from the co-op's today", () => {
  assert.equal(vault.expiryState(null, "2026-11-21"), null);
  assert.deepEqual(vault.expiryState("2026-11-20", "2026-11-21"), { tone: "expired", label: "Expired yesterday" });
  assert.equal(vault.expiryState("2026-11-01", "2026-11-21").label, "Expired 20 days ago");
  assert.equal(vault.expiryState("2026-11-21", "2026-11-21").label, "Expires today");
  assert.equal(vault.expiryState("2026-11-22", "2026-11-21").label, "Expires tomorrow");
  assert.equal(vault.expiryState("2027-01-20", "2026-11-21").tone, "soon");
  assert.equal(vault.expiryState("2027-06-01", "2026-11-21").tone, "ok");
  assert.equal(vault.longDate("2027-03-01"), "March 1, 2027");
});

test("erasing needs an archived record past its keep-until date", () => {
  assert.match(vault.eraseBlocker({ archived_at: null, retain_until: null }, "2026-11-21"), /Archive the record first/);
  assert.match(vault.eraseBlocker({ archived_at: "2026-11-01T00:00:00Z", retain_until: "2030-01-01" }, "2026-11-21"), /kept until January 1, 2030/);
  assert.equal(vault.eraseBlocker({ archived_at: "2026-11-01T00:00:00Z", retain_until: "2026-11-21" }, "2026-11-21"), null);
  assert.equal(vault.eraseBlocker({ archived_at: "2026-11-01T00:00:00Z", retain_until: null }, "2026-11-21"), null);
});

test("history names the fields that changed between revisions", () => {
  const a = { title: "Policy", tags: ["fire"], expires_on: "2026-12-31", archived: false };
  assert.deepEqual(vault.snapshotChanges(null, a), []);
  assert.deepEqual(vault.snapshotChanges(a, { ...a, tags: ["fire", "liability"], expires_on: "2027-12-31" }), ["expiry date", "tags"]);
  assert.deepEqual(vault.snapshotChanges(a, { ...a, archived: true }), ["archived"]);
  assert.equal(vault.describeRecordEvent("record_file_viewed", { version_no: 2 }), "Viewed the file (version 2)");
  assert.equal(vault.describeRecordEvent("record_file_downloaded", {}), "Downloaded the file");
});

test("upload registers the file, and a failed registration removes the upload", async () => {
  const calls = [];
  const fake = (rpcError) => ({
    storage: { from: (bucket) => ({
      upload: async (p, _file, opts) => { calls.push(["upload", bucket, p, opts.upsert]); return { error: null }; },
      remove: async (paths) => { calls.push(["remove", paths]); return { error: null }; },
    }) },
    rpc: async (fn, args) => { calls.push(["rpc", fn, args]); return rpcError ? { data: null, error: { message: rpcError } } : { data: 2, error: null }; },
  });
  const file = new File([new TextEncoder().encode("abc")], "policy.pdf", { type: "application/pdf" });
  const record = "6f1c2b9e-1111-4a4a-9c9c-123456789abc";
  assert.equal(await vault.uploadRecordFile(fake(null), record, file, "Renewed"), 2);
  const [up, rpc] = calls;
  assert.equal(up[1], "family-village-private");
  assert.equal(up[3], false, "never overwrites");
  assert.equal(rpc[1], "admin_add_record_file");
  assert.equal(rpc[2].p_path, up[2]);
  assert.match(rpc[2].p_path, new RegExp(`^records/${record}/${rpc[2].p_file_id}\\.pdf$`));
  assert.equal(rpc[2].p_sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  calls.length = 0;
  await assert.rejects(vault.uploadRecordFile(fake("Say what changed in this version."), record, file, null), /Say what changed/);
  assert.deepEqual(calls.at(-1), ["remove", [calls[0][2]]]);
});

test("a file is only ever read through the logged open step", async () => {
  const calls = [];
  const fake = {
    rpc: async (fn, args) => { calls.push([fn, args]); return { data: "records/r/f.pdf", error: null }; },
    storage: { from: () => ({ createSignedUrl: async (p, ttl, opts) => { calls.push(["sign", p, ttl, opts]); return { data: { signedUrl: "https://signed" }, error: null }; } }) },
  };
  assert.equal(await vault.recordFileUrl(fake, "f", "download", "policy.pdf"), "https://signed");
  assert.deepEqual(calls[0], ["admin_open_record_file", { p_file: "f", p_purpose: "download" }]);
  assert.deepEqual(calls[1], ["sign", "records/r/f.pdf", 120, { download: "policy.pdf" }]);
  // The tab never signs a records/ link itself.
  assert.doesNotMatch(tab, /createSignedUrl|getSignedFileUrl/);
  assert.doesNotMatch(tab, /from\("org_facts"\)/, "facts are read only through the masking functions");
});

test("the tab is in the Admin workspace and the Records group", async () => {
  const workspace = await readFile(new URL("../app/family-village/admin/workspace.tsx", import.meta.url), "utf8");
  assert.match(workspace, /import\("\.\/records-vault-tab"\)/);
  // Board-only since admin permissions: shown with the "Tax and compliance records" permission.
  assert.match(workspace, /tab === "vault" && \(adminAccess\.loading \? null : adminAccess\.can\("tax_compliance"\) \? <RecordsVaultTab \/>/);
  const nav = await readFile(new URL("../lib/desktop-nav.ts", import.meta.url), "utf8");
  assert.match(nav, /id: "records",[^\n]*\{ id: "vault", label: "Records vault" \}/);
});

test("the vault stylesheet uses role tokens, not colours", async () => {
  const css = await readFile(new URL("../app/records-vault.css", import.meta.url), "utf8");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/);
  assert.doesNotMatch(css, /var\(--(navy|terracotta|cream|sage|antique-gold)\)/);
});
