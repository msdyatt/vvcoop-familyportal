/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { audienceReady, describeExtras, describePreview, looksUnfinished, previewKey, type Preview } from "./broadcast.ts";

const base: Preview = { total: 142, push: 118, email_only: 20, sms_only: 0, unreachable: 4, also_email: 90, also_sms: 3, email: 110, sms: 5, quiet_held: 0, immediate: false };

Deno.test("describePreview: says who is reached by which channel, in the words the admin asked for", () => {
  assertEquals(describePreview(base), "142 people: 118 push, 20 email only, 4 unreachable");
  assertEquals(describePreview({ ...base, total: 1, push: 1, email_only: 0, unreachable: 0 }), "1 person: 1 push");
  assertEquals(describePreview({ ...base, total: 0, push: 0, email_only: 0, unreachable: 0 }), "0 people");
  assertEquals(describePreview({ ...base, sms_only: 2 }), "142 people: 118 push, 20 email only, 2 text only, 4 unreachable");
});

Deno.test("describeExtras: urgent says what goes out right now; others say what happens later", () => {
  const urgent = describeExtras({ ...base, immediate: true }, "urgent");
  assert(urgent.some((l) => l === "110 people get an email right now."));
  assert(urgent.some((l) => l === "5 people get a text right now."));
  const notice = describeExtras({ ...base, sms: 0, quiet_held: 2 }, "notice");
  assert(notice.some((l) => l.startsWith("90 more people will be emailed if they haven")));
  assert(notice.some((l) => l.includes("2 people have “only urgent things” on")));
  assertFalse(describeExtras(base, "urgent").some((l) => l.includes("only urgent things")));
  assertEquals(describeExtras({ ...base, email: 1, sms: 0, unreachable: 0, also_email: 0 }, "urgent"), ["1 person gets an email right now."]);
});

Deno.test("audienceReady: a class, grade or hand-picked audience must actually pick something", () => {
  assert(audienceReady({ type: "everyone" }));
  assert(audienceReady({ type: "teachers" }));
  assertFalse(audienceReady({ type: "class", class_id: "" }));
  assert(audienceReady({ type: "class", class_id: "c1" }));
  assertFalse(audienceReady({ type: "grade", grade: "" }));
  assertFalse(audienceReady({ type: "people", user_ids: [] }));
  assert(audienceReady({ type: "people", user_ids: ["u1"] }));
});

Deno.test("previewKey: changes with the audience or severity, not with the order people were ticked", () => {
  const a = previewKey({ type: "people", user_ids: ["b", "a"] }, "notice");
  assertEquals(a, previewKey({ type: "people", user_ids: ["a", "b"] }, "notice"));
  assert(a !== previewKey({ type: "people", user_ids: ["a", "b"] }, "urgent"));
  assert(a !== previewKey({ type: "people", user_ids: ["a"] }, "notice"));
  assert(previewKey({ type: "everyone" }, "notice") !== previewKey({ type: "teachers" }, "notice"));
});

Deno.test("looksUnfinished: catches bracketed placeholders and TBD, leaves ordinary text alone", () => {
  assert(looksUnfinished("Class is moved to [new day]."));
  assert(looksUnfinished("Starting time TBD"));
  assertFalse(looksUnfinished("Class is moved to Thursday (rain date Friday)."));
  assertFalse(looksUnfinished(""));
});
