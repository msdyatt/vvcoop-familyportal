/// <reference lib="deno.ns" />
import { assert, assertEquals, assertMatch, assertNotEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { decodePDFRawStream, degrees, PDFDocument, PDFRawStream } from "npm:pdf-lib@1.17.1";
import { sealRequest, bodyPath, sealedPath, type SealStore } from "./esign-seal.ts";
import { encodable, flattenSigned, sha256Hex, visibleToPage, type SealRecord, type SealRequest } from "./esign-pdf.ts";

// A 1x1 PNG, standing in for a signature drawn on screen.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function makePdf(pages: number, rotatePage2 = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    if (i === 1 && rotatePage2) p.setRotation(degrees(rotatePage2));
  }
  return await doc.save();
}

const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Every stream in the PDF, decompressed, as text, so tests can look for what was drawn. */
async function allStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = new TextDecoder("latin1").decode(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) out += "\n" + new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
  }
  return out;
}
const contains = async (bytes: Uint8Array, needle: string) => (await allStreams(bytes)).toLowerCase().includes(hex(needle));

function record(): SealRecord {
  return {
    signers: [
      { id: "s1", slot: 1, display_name: "Parent One", email: "one@example.test", status: "signed", consented_at: "2026-11-06T15:00:00Z",
        consent_text_sha256: "c".repeat(64), signed_at: "2026-11-06T15:05:00Z", signature: { kind: "typed", text: "Parent One" }, initials: null },
      { id: "s2", slot: 2, display_name: "Parent Two", email: null, status: "signed", consented_at: "2026-11-06T16:00:00Z",
        consent_text_sha256: "c".repeat(64), signed_at: "2026-11-06T16:05:00Z", signature: { kind: "drawn", png: PNG }, initials: { kind: "typed", text: "PT" } },
    ],
    fields: [
      { id: "f1", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.05, kind: "signature", signer_slot: 1, label: null },
      { id: "f2", page: 1, x: 0.5, y: 0.8, w: 0.2, h: 0.04, kind: "date", signer_slot: 1, label: null },
      { id: "f3", page: 2, x: 0.1, y: 0.3, w: 0.4, h: 0.04, kind: "text", signer_slot: 1, label: "Phone" },
      { id: "f4", page: 3, x: 0.1, y: 0.8, w: 0.3, h: 0.05, kind: "signature", signer_slot: 2, label: null },
      { id: "f5", page: 3, x: 0.5, y: 0.8, w: 0.1, h: 0.04, kind: "initials", signer_slot: 2, label: null },
      { id: "f6", page: 3, x: 0.1, y: 0.7, w: 0.03, h: 0.03, kind: "checkbox", signer_slot: 2, label: null },
    ],
    values: [
      { field_id: "f1", signer_id: "s1", value: "adopted" },
      { field_id: "f2", signer_id: "s1", value: "2026-11-06" },
      { field_id: "f3", signer_id: "s1", value: "555-0142 ☎" },
      { field_id: "f4", signer_id: "s2", value: "adopted" },
      { field_id: "f5", signer_id: "s2", value: "adopted" },
      { field_id: "f6", signer_id: "s2", value: "true" },
    ],
    events: [
      { id: 1, signer_id: null, action: "created", actor_name: "Admin", ip: "198.51.100.1", user_agent: "Admin/1", detail: {}, created_at: "2026-11-06T14:00:00Z" },
      { id: 2, signer_id: "s1", action: "consent_given", actor_name: "Parent One", ip: "203.0.113.9", user_agent: "TestAgent/1.0", detail: {}, created_at: "2026-11-06T15:00:00Z" },
      { id: 3, signer_id: "s1", action: "field_filled", actor_name: "Parent One", ip: "203.0.113.9", user_agent: "TestAgent/1.0", detail: {}, created_at: "2026-11-06T15:05:00Z" },
      { id: 4, signer_id: "s1", action: "field_filled", actor_name: "Parent One", ip: "203.0.113.9", user_agent: "TestAgent/1.0", detail: {}, created_at: "2026-11-06T15:05:00Z" },
      { id: 5, signer_id: "s1", action: "signed", actor_name: "Parent One", ip: "203.0.113.9", user_agent: "TestAgent/1.0", detail: {}, created_at: "2026-11-06T15:05:00Z" },
      { id: 6, signer_id: "s2", action: "signed", actor_name: "Parent Two", ip: "203.0.113.77", user_agent: "Other/2", detail: {}, created_at: "2026-11-06T16:05:00Z" },
    ],
  };
}

type Calls = { claimed: number; uploads: Map<string, Uint8Array>; completed: { sealed: string; body: string }[]; failed: string[] };

async function fakeStore(over: { original?: Uint8Array; status?: string; claim?: boolean; request?: Partial<SealRequest> } = {}) {
  const original = over.original ?? await makePdf(3);
  const calls: Calls = { claimed: 0, uploads: new Map(), completed: [], failed: [] };
  const req: SealRequest = {
    id: "11111111-1111-4111-8111-111111111111", title: "Liability waiver", status: over.status ?? "signed",
    original_path: "sign/templates/x/original.pdf", original_sha256: await sha256Hex(original), page_count: 3,
    template_id: "t1", signing_order: "any", sealed_sha256: null, document_id: null, ...over.request,
  };
  const store: SealStore = {
    getRequest: () => Promise.resolve(req),
    claim: () => { calls.claimed += 1; return Promise.resolve(over.claim ?? true); },
    loadRecord: () => Promise.resolve(record()),
    download: () => Promise.resolve(original),
    upload: (path, bytes) => { calls.uploads.set(path, bytes); return Promise.resolve(); },
    complete: (_id, sealed, body) => { calls.completed.push({ sealed, body }); return Promise.resolve(); },
    fail: (_id, message) => { calls.failed.push(message); return Promise.resolve(); },
  };
  return { store, calls, req, original };
}

Deno.test("seal: stores the signed content and the sealed PDF, and records both hashes", async () => {
  const { store, calls, req } = await fakeStore();
  const out = await sealRequest(store, req.id);
  assert(out.ok);
  assertEquals(calls.failed, []);
  const sealed = calls.uploads.get(sealedPath(req.id))!;
  const body = calls.uploads.get(bodyPath(req.id))!;
  assert(sealed && body);
  assertEquals(calls.completed, [{ sealed: await sha256Hex(sealed), body: await sha256Hex(body) }]);
  assertMatch(calls.completed[0].sealed, /^[0-9a-f]{64}$/);
  assertNotEquals(calls.completed[0].sealed, calls.completed[0].body);
});

Deno.test("seal: the original's pages are kept and the certificate is added after them", async () => {
  const { store, calls, req } = await fakeStore();
  await sealRequest(store, req.id);
  const body = await PDFDocument.load(calls.uploads.get(bodyPath(req.id))!);
  const sealed = await PDFDocument.load(calls.uploads.get(sealedPath(req.id))!);
  assertEquals(body.getPageCount(), 3);
  assert(sealed.getPageCount() >= 4);
});

Deno.test("seal: typed signature, text answer and date are drawn on the pages; the stray emoji does not break it", async () => {
  const { store, calls, req } = await fakeStore();
  await sealRequest(store, req.id);
  const body = calls.uploads.get(bodyPath(req.id))!;
  assert(await contains(body, "Parent One"), "typed signature");
  assert(await contains(body, "2026-11-06"), "date");
  assert(await contains(body, "555-0142 ?"), "text answer with the unsupported character replaced");
  assert(await contains(body, "PT"), "typed initials");
});

Deno.test("seal: a drawn signature is embedded as an image", async () => {
  const { store, calls, req } = await fakeStore();
  await sealRequest(store, req.id);
  const text = new TextDecoder("latin1").decode(calls.uploads.get(bodyPath(req.id))!);
  assertStringIncludes(text, "/Subtype /Image");
});

Deno.test("seal: the certificate lists signers, hashes and the audit trail", async () => {
  const { store, calls, req } = await fakeStore();
  await sealRequest(store, req.id);
  const sealed = calls.uploads.get(sealedPath(req.id))!;
  for (const needle of [
    "Certificate of Completion", "Parent One", "Parent Two", "203.0.113.9", "203.0.113.77", req.original_sha256.slice(0, 32),
    calls.completed[0].body.slice(0, 32), "Agreed to sign electronically", "Filled in fields (2)", "removed at the person's request",
    "No independent trusted timestamp",
  ]) assert(await contains(sealed, needle), `certificate should mention ${needle}`);
});

Deno.test("seal: refuses and records the failure when the stored original no longer matches the hash it was sent with", async () => {
  const { store, calls, req } = await fakeStore();
  const tampered = await makePdf(3);
  const bad: SealStore = { ...store, download: () => Promise.resolve(new Uint8Array([...tampered, 0x20])) };
  const out = await sealRequest(bad, req.id);
  assertEquals(out.ok, false);
  assertEquals(calls.completed.length, 0);
  assertEquals(calls.uploads.size, 0);
  assertEquals(calls.failed.length, 1);
  assertStringIncludes(calls.failed[0], "no longer matches");
});

Deno.test("seal: not ready until everyone has signed", async () => {
  const { store, calls, req } = await fakeStore({ status: "in_progress" });
  const out = await sealRequest(store, req.id);
  assertEquals(out.ok, false);
  assertEquals(calls.claimed, 0);
  assertEquals(calls.uploads.size, 0);
});

Deno.test("seal: steps aside when another call holds the claim", async () => {
  const { store, calls, req } = await fakeStore({ claim: false });
  const out = await sealRequest(store, req.id);
  assertEquals(out, { ok: false, status: "busy", message: "This is already being sealed." });
  assertEquals(calls.uploads.size, 0);
});

Deno.test("seal: a request that is already sealed is returned untouched", async () => {
  const { store, calls, req } = await fakeStore({ status: "completed", request: { sealed_sha256: "a".repeat(64) } });
  const out = await sealRequest(store, req.id);
  assertEquals(out.ok && out.alreadySealed, true);
  assertEquals(calls.claimed, 0);
  assertEquals(calls.uploads.size, 0);
});

Deno.test("seal: a signer who has not finished stops the seal", async () => {
  const { store, calls, req } = await fakeStore();
  const unfinished: SealStore = { ...store, loadRecord: () => { const r = record(); r.signers[1].status = "pending"; return Promise.resolve(r); } };
  const out = await sealRequest(unfinished, req.id);
  assertEquals(out.ok, false);
  assertEquals(calls.completed.length, 0);
});

Deno.test("seal: a failure while storing is recorded, nothing is marked complete", async () => {
  const { store, calls, req } = await fakeStore();
  const broken: SealStore = { ...store, upload: () => Promise.reject(new Error("storage down")) };
  const out = await sealRequest(broken, req.id);
  assertEquals(out.ok, false);
  assertEquals(calls.completed.length, 0);
  assertEquals(calls.failed, ["storage down"]);
});

Deno.test("seal: a rotated page still gets its fields", async () => {
  const original = await makePdf(3, 90);
  const { store, calls, req } = await fakeStore({ original });
  const out = await sealRequest(store, req.id);
  assert(out.ok);
  assert(await contains(calls.uploads.get(bodyPath(req.id))!, "555-0142 ?"));
});

Deno.test("flatten: output is a valid PDF with the same page count", async () => {
  const out = await flattenSigned(await makePdf(3), record(), "T");
  assertEquals((await PDFDocument.load(out)).getPageCount(), 3);
});

Deno.test("visibleToPage: an unrotated page maps top-left fractions onto the usual bottom-left origin", () => {
  const box = { x: 0, y: 0, width: 600, height: 800 };
  assertEquals(visibleToPage(box, 0, 0, 0), { x: 0, y: 0 });
  assertEquals(visibleToPage(box, 0, 100, 700), { x: 100, y: 700 });
});

Deno.test("visibleToPage: a page shown rotated 90 degrees clockwise", () => {
  // Unrotated 600x800 displays as 800 wide, 600 tall. The visible bottom-left is the page's top-left.
  const box = { x: 0, y: 0, width: 600, height: 800 };
  assertEquals(visibleToPage(box, 90, 0, 0), { x: 600, y: 0 });
  // visible top-left (0, 600) is the page's bottom-left
  assertEquals(visibleToPage(box, 90, 0, 600), { x: 0, y: 0 });
  // visible bottom-right (800, 0) is the page's top-right
  assertEquals(visibleToPage(box, 90, 800, 0), { x: 600, y: 800 });
});

Deno.test("visibleToPage: a page shown rotated 180 degrees", () => {
  const box = { x: 0, y: 0, width: 600, height: 800 };
  assertEquals(visibleToPage(box, 180, 0, 0), { x: 600, y: 800 });
  assertEquals(visibleToPage(box, 180, 600, 800), { x: 0, y: 0 });
});

Deno.test("encodable: replaces what the built-in fonts cannot draw", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont("Helvetica");
  assertEquals(encodable(font, "Zoë 😀 ok"), "Zoë ? ok");
});
