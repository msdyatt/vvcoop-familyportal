/// <reference lib="deno.ns" />
/**
 * Regression tests for the two calendar-feed bugs fixed alongside them:
 *
 *  1. a class in more than one academic term was collapsed into a single
 *     min..max RRULE that met every week straight through the gap between
 *     terms (e.g. winter break);
 *  2. the weekly meeting was emitted as a bare-UTC DTSTART + RRULE, so a
 *     subscribing app expanded it by a fixed 168-hour step and every
 *     occurrence after a DST change landed an hour off.
 *
 * These cover the pure pieces without the edge runtime's npm imports; the
 * end-to-end expansion across the DST boundary is checked separately with a
 * real iCalendar parser (see the note at the bottom of this file).
 *
 *   deno test --no-check supabase/functions/calendar-feed/feed.test.ts
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { mergeContiguousRanges } from "../_shared/date-ranges.ts";
import { buildIcs, IcsEvent } from "../_shared/ics.ts";

// --- mergeContiguousRanges ------------------------------------------------

Deno.test("mergeContiguousRanges: empty and singletons pass through", () => {
  assertEquals(mergeContiguousRanges([]), []);
  assertEquals(
    mergeContiguousRanges([{ starts: "2026-08-24", ends: "2026-12-18" }]),
    [{ starts: "2026-08-24", ends: "2026-12-18" }],
  );
});

Deno.test("mergeContiguousRanges: Fall + Spring stay two spans (winter break between them)", () => {
  assertEquals(
    mergeContiguousRanges([
      { starts: "2026-08-24", ends: "2026-12-18" },
      { starts: "2027-01-05", ends: "2027-05-22" },
    ]),
    [
      { starts: "2026-08-24", ends: "2026-12-18" },
      { starts: "2027-01-05", ends: "2027-05-22" },
    ],
  );
});

Deno.test("mergeContiguousRanges: unsorted input is sorted before merging", () => {
  const out = mergeContiguousRanges([
    { starts: "2027-01-05", ends: "2027-05-22" },
    { starts: "2026-08-24", ends: "2026-12-18" },
  ]);
  assertEquals(out.map((range) => range.starts), ["2026-08-24", "2027-01-05"]);
});

Deno.test("mergeContiguousRanges: back-to-back quarters (no gap) merge into one span", () => {
  assertEquals(
    mergeContiguousRanges([
      { starts: "2026-08-24", ends: "2026-10-31" },
      { starts: "2026-11-01", ends: "2027-01-15" },
    ]),
    [{ starts: "2026-08-24", ends: "2027-01-15" }],
  );
});

Deno.test("mergeContiguousRanges: overlapping and fully-nested ranges merge", () => {
  assertEquals(
    mergeContiguousRanges([
      { starts: "2026-08-24", ends: "2026-12-18" },
      { starts: "2026-09-01", ends: "2026-10-01" }, // nested inside the first
      { starts: "2026-12-10", ends: "2027-02-01" }, // overlaps the first's tail
    ]),
    [{ starts: "2026-08-24", ends: "2027-02-01" }],
  );
});

Deno.test("mergeContiguousRanges: a two-day gap still splits", () => {
  const out = mergeContiguousRanges([
    { starts: "2026-08-24", ends: "2026-12-18" },
    { starts: "2026-12-20", ends: "2027-05-22" },
  ]);
  assertEquals(out.length, 2);
});

Deno.test("mergeContiguousRanges: three terms, gap only before the third", () => {
  assertEquals(
    mergeContiguousRanges([
      { starts: "2026-08-24", ends: "2026-10-31" },
      { starts: "2026-11-01", ends: "2026-12-18" },
      { starts: "2027-01-05", ends: "2027-05-22" },
    ]),
    [
      { starts: "2026-08-24", ends: "2026-12-18" },
      { starts: "2027-01-05", ends: "2027-05-22" },
    ],
  );
});

// --- buildIcs: zoned recurring meeting ----------------------------------

/** What classMeetingEvents() now produces for one contiguous term span of a Friday 2:00-3:30pm class. */
function meetingEvent(uid: string, firstFriday: string, untilUtc: string): IcsEvent {
  return {
    uid,
    title: "Pottery",
    location: "Room A",
    allDay: false,
    local: { tzid: "America/Chicago", startsAt: `${firstFriday}T14:00:00`, endsAt: `${firstFriday}T15:30:00` },
    rrule: { byDay: "FR", until: untilUtc },
  };
}

Deno.test("buildIcs: recurring meeting uses local time + TZID, never a bare-UTC start", () => {
  const ics = buildIcs(
    [meetingEvent("class-x@veritasvillage", "2026-08-28", "2026-12-18T21:30:00.000Z")],
    { name: "Class" },
  );
  assert(ics.includes("DTSTART;TZID=America/Chicago:20260828T140000"));
  assert(ics.includes("DTEND;TZID=America/Chicago:20260828T153000"));
  assert(!/DTSTART:\d{8}T\d{6}Z/.test(ics), "a recurring DTSTART must not be a frozen UTC instant");
  // RFC 5545 3.3.10: UNTIL stays in UTC even when DTSTART carries a TZID.
  assert(/RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261218T213000Z/.test(ics));
});

Deno.test("buildIcs: one VTIMEZONE for America/Chicago, with the post-2007 US DST rule, before the VEVENTs", () => {
  const ics = buildIcs([
    meetingEvent("class-x-2026-08-28@veritasvillage", "2026-08-28", "2026-12-18T21:30:00.000Z"),
    meetingEvent("class-x-2027-01-08@veritasvillage", "2027-01-08", "2027-05-22T20:30:00.000Z"),
  ], { name: "Class" });

  assertEquals(ics.match(/BEGIN:VTIMEZONE/g)?.length, 1, "exactly one VTIMEZONE even with two zoned events");
  assert(ics.includes("TZID:America/Chicago"));
  assert(ics.includes("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU"), "spring forward: 2nd Sunday of March");
  assert(ics.includes("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"), "fall back: 1st Sunday of November");
  assert(ics.includes("TZOFFSETFROM:-0600") && ics.includes("TZOFFSETTO:-0500"), "DAYLIGHT: CST -> CDT");
  assert(ics.includes("TZOFFSETFROM:-0500") && ics.includes("TZOFFSETTO:-0600"), "STANDARD: CDT -> CST");
  assert(ics.indexOf("BEGIN:VTIMEZONE") < ics.indexOf("BEGIN:VEVENT"), "VTIMEZONE must precede the events that use it");
});

Deno.test("buildIcs: a multi-span class emits one bounded VEVENT per span, with distinct UIDs", () => {
  const ics = buildIcs([
    meetingEvent("class-x-2026-08-28@veritasvillage", "2026-08-28", "2026-12-18T21:30:00.000Z"),
    meetingEvent("class-x-2027-01-08@veritasvillage", "2027-01-08", "2027-05-22T20:30:00.000Z"),
  ], { name: "Class" });

  assertEquals(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assertEquals(
    [...ics.matchAll(/UNTIL=(\d{8}T\d{6}Z)/g)].map((m) => m[1]),
    ["20261218T213000Z", "20270522T203000Z"],
    "each span's RRULE ends at its own term end -- neither runs through the winter gap",
  );
  assert(ics.includes("UID:class-x-2026-08-28@veritasvillage"));
  assert(ics.includes("UID:class-x-2027-01-08@veritasvillage"));
});

Deno.test("buildIcs: a single-span class keeps the bare class-<id> UID so existing subscriptions don't churn", () => {
  const ics = buildIcs(
    [meetingEvent("class-x@veritasvillage", "2026-08-28", "2027-05-22T20:30:00.000Z")],
    { name: "Class" },
  );
  assert(ics.includes("UID:class-x@veritasvillage"));
});

Deno.test("buildIcs: plain dated events keep their bare-UTC DTSTART and pull in no VTIMEZONE", () => {
  const ics = buildIcs([{
    uid: "event-1@veritasvillage",
    title: "Fall Fair",
    description: null,
    location: null,
    startsAt: "2026-10-03T17:00:00.000Z",
    endsAt: "2026-10-03T20:00:00.000Z",
    allDay: false,
  }], { name: "Village" });

  assert(ics.includes("DTSTART:20261003T170000Z"));
  assert(!ics.includes("VTIMEZONE"));
  assert(!ics.includes("TZID="));
});

Deno.test("buildIcs: all-day events are unchanged (VALUE=DATE, exclusive DTEND)", () => {
  const ics = buildIcs([{
    uid: "event-2@veritasvillage",
    title: "Closed week",
    description: null,
    location: null,
    startsAt: "2026-11-23T00:00:00.000Z",
    endsAt: "2026-11-27T00:00:00.000Z",
    allDay: true,
  }], { name: "Village" });

  assert(ics.includes("DTSTART;VALUE=DATE:20261123"));
  assert(ics.includes("DTEND;VALUE=DATE:20261128"));
});

/*
 * End-to-end DST + gap check (run manually; needs npm:ical.js, which the
 * committed suite deliberately does not depend on):
 *
 *   deno run --node-modules-dir=auto -A supabase/functions/calendar-feed/feed.dst-check.ts
 *
 * It builds the feed for a Fall+Spring Friday-2pm class, parses it with
 * ical.js, expands both VEVENTs from Aug 2026 to Jun 2027, and asserts every
 * occurrence is 14:00 America/Chicago (including the Dec/Jan/Feb ones, past
 * both DST transitions) and that none land inside the winter break.
 */
