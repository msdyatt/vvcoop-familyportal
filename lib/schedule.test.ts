/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { formatDayShort, nextMeetingDay } from "./schedule.ts";

// Wednesday 11 Nov 2026 (local time, so the test does not depend on the machine's zone).
const wed = new Date(2026, 10, 11, 15, 30);
const FRIDAY = 5;
const WEDNESDAY = 3;
const TUESDAY = 2;

Deno.test("a class with no term meets on the next matching weekday", () => {
  assertEquals(nextMeetingDay(FRIDAY, [], wed), "2026-11-13");
});

Deno.test("a class that meets today counts today", () => {
  assertEquals(nextMeetingDay(WEDNESDAY, [], wed), "2026-11-11");
});

Deno.test("the weekday rolls into next week", () => {
  assertEquals(nextMeetingDay(TUESDAY, [], wed), "2026-11-17");
});

Deno.test("a term that has not started yet pushes the first meeting to its start", () => {
  assertEquals(nextMeetingDay(FRIDAY, [{ starts_on: "2027-01-11", ends_on: "2027-05-14" }], wed), "2027-01-15");
});

Deno.test("a term that has ended is skipped, and a class whose terms are all over has no next meeting", () => {
  const over = { starts_on: "2026-08-24", ends_on: "2026-11-06" };
  assertEquals(nextMeetingDay(FRIDAY, [over], wed), null);
  assertEquals(nextMeetingDay(FRIDAY, [over, { starts_on: "2027-01-11", ends_on: "2027-05-14" }], wed), "2027-01-15");
});

Deno.test("the last day of a term still counts, the day after does not", () => {
  assertEquals(nextMeetingDay(FRIDAY, [{ starts_on: "2026-08-24", ends_on: "2026-11-13" }], wed), "2026-11-13");
  assertEquals(nextMeetingDay(FRIDAY, [{ starts_on: "2026-08-24", ends_on: "2026-11-12" }], wed), null);
});

Deno.test("no weekday set means no next meeting", () => {
  assertEquals(nextMeetingDay(null, [], wed), null);
  assertEquals(nextMeetingDay(undefined, [], wed), null);
});

Deno.test("a day is formatted without drifting across midnight", () => {
  assertEquals(formatDayShort("2026-11-13"), "Fri, Nov 13");
});
