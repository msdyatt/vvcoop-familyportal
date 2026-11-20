/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  buildTimeline, describeEvent, emailDocument, formatBytes, formatMoneyCents, hasRemoteImages, listTime, senderLabel, splitQuoted, statusLabel,
} from "./office-inbox.ts";

Deno.test("emailDocument: remote content is blocked until asked for, and then only images", () => {
  const blocked = emailDocument("<p>Hi</p>", false);
  assertStringIncludes(blocked, "default-src 'none'; img-src data: cid:;");
  assertFalse(blocked.includes("https:"));
  assertStringIncludes(blocked, '<base target="_blank">');
  assertStringIncludes(blocked, '<meta name="referrer" content="no-referrer">');
  const allowed = emailDocument("<p>Hi</p>", true);
  assertStringIncludes(allowed, "img-src data: cid: https:;");
  assertFalse(/script-src|connect-src|frame-src/.test(allowed));
});

Deno.test("hasRemoteImages: only http(s) image sources count", () => {
  assert(hasRemoteImages('<img src="https://t.example/p.gif">'));
  assert(hasRemoteImages("<IMG width=1 SRC=http://t.example/p.gif>"));
  assertFalse(hasRemoteImages('<img src="cid:logo">'));
  assertFalse(hasRemoteImages('<a href="https://example.org">link</a>'));
  assertFalse(hasRemoteImages(null));
});

Deno.test("buildTimeline: messages, notes and history in time order", () => {
  const items = buildTimeline({
    messages: [{ id: "m2", sent_at: "2026-11-18T12:00:00Z" }, { id: "m1", sent_at: "2026-11-18T09:00:00Z" }] as never,
    notes: [{ id: "n1", body: "x", author_name: null, created_at: "2026-11-18T10:00:00Z" }],
    events: [{ kind: "status", detail: { to: "open" }, actor_name: "Sam", created_at: "2026-11-18T12:00:00Z" }],
  });
  assertEquals(items.map((i) => i.kind), ["message", "note", "message", "event"]);
});

Deno.test("describeEvent: plain sentences for the history", () => {
  assertEquals(describeEvent({ kind: "status", detail: { from: "new", to: "done" }, actor_name: "Sam", created_at: "" }), "Sam set the status to Done.");
  assertEquals(describeEvent({ kind: "status", detail: { to: "open", reason: "new_mail" }, actor_name: null, created_at: "" }), "New mail moved this back to Open.");
  assertEquals(describeEvent({ kind: "assigned", detail: { to: "u2", to_name: "Alex" }, actor_name: "Sam", created_at: "" }), "Sam assigned this to Alex.");
  assertEquals(describeEvent({ kind: "assigned", detail: { to: null }, actor_name: "Sam", created_at: "" }), "Sam removed the assignment.");
  assertEquals(describeEvent({ kind: "category", detail: { to: "reimbursement" }, actor_name: "Sam", created_at: "" }), "Sam changed the category to Reimbursement.");
  assertEquals(statusLabel("waiting"), "Waiting on family");
});

Deno.test("splitQuoted: the new part and the quoted history", () => {
  assertEquals(splitQuoted("Thanks!\n\nOn Tue, Nov 18, 2026 at 9:00 AM Office <o@x.org> wrote:\n> Hello"), { fresh: "Thanks!", quoted: "On Tue, Nov 18, 2026 at 9:00 AM Office <o@x.org> wrote:\n> Hello" });
  assertEquals(splitQuoted("Yes please\n> earlier\n>\n> more"), { fresh: "Yes please", quoted: "> earlier\n>\n> more" });
  assertEquals(splitQuoted("> quoting in the middle\nthen my answer"), { fresh: "> quoting in the middle\nthen my answer", quoted: "" });
  assertEquals(splitQuoted("Just text"), { fresh: "Just text", quoted: "" });
});

Deno.test("small formatters", () => {
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(20_480), "20 KB");
  assertEquals(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assertEquals(formatBytes(null), "");
  assertEquals(formatMoneyCents(123456), "$1,234.56");
  assertEquals(senderLabel("Ann", "ann@x.org"), "Ann <ann@x.org>");
  assertEquals(senderLabel(null, null), "Unknown sender");
  const now = new Date("2026-11-19T18:00:00Z");
  assertEquals(listTime("2026-11-19T15:30:00Z", now), "9:30 AM");
  assertEquals(listTime("2026-11-17T15:30:00Z", now), "Tue");
  assertEquals(listTime("2026-10-02T15:30:00Z", now), "Oct 2");
  assertEquals(listTime("2025-10-02T15:30:00Z", now), "Oct 2, 2025");
});
