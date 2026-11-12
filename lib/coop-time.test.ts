/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { addCalendarDays, coopWallTime, coopWallTimeToDate, formatCoopDateTime } from "./coop-time.ts";

const iso = (date: string, time: string) => coopWallTimeToDate(date, time)?.toISOString();

Deno.test("8:00 AM Central is 14:00 UTC in winter and 13:00 UTC in summer", () => {
  assertEquals(iso("2026-11-19", "08:00"), "2026-11-19T14:00:00.000Z"); // CST, UTC-6
  assertEquals(iso("2026-07-15", "08:00"), "2026-07-15T13:00:00.000Z"); // CDT, UTC-5
});

Deno.test("a time keeps its wall-clock hour across the daylight-saving changes", () => {
  // Clocks fall back on Sunday 1 Nov 2026 and spring forward on Sunday 8 Mar 2026.
  assertEquals(iso("2026-10-31", "09:00"), "2026-10-31T14:00:00.000Z");
  assertEquals(iso("2026-11-01", "09:00"), "2026-11-01T15:00:00.000Z");
  assertEquals(iso("2026-03-07", "09:00"), "2026-03-07T15:00:00.000Z");
  assertEquals(iso("2026-03-08", "09:00"), "2026-03-08T14:00:00.000Z");
});

Deno.test("a time that does not exist lands an hour later, one that happens twice means the first", () => {
  assertEquals(coopWallTime(coopWallTimeToDate("2026-03-08", "02:30")!), { date: "2026-03-08", time: "03:30" });
  assertEquals(iso("2026-11-01", "01:30"), "2026-11-01T06:30:00.000Z"); // the CDT one, before clocks go back
});

Deno.test("an instant reads back as the same Central wall time", () => {
  assertEquals(coopWallTime("2026-11-19T14:00:00.000Z"), { date: "2026-11-19", time: "08:00" });
  assertEquals(coopWallTime("2026-07-15T04:30:00.000Z"), { date: "2026-07-14", time: "23:30" }); // still the day before in Chicago
  assertEquals(coopWallTime("2026-11-01T06:30:00.000Z"), { date: "2026-11-01", time: "01:30" });
});

Deno.test("malformed or impossible dates are rejected", () => {
  assertEquals(coopWallTimeToDate("2026-11-31", "08:00"), null);
  assertEquals(coopWallTimeToDate("2026-13-01", "08:00"), null);
  assertEquals(coopWallTimeToDate("2026-11-19", "25:00"), null);
  assertEquals(coopWallTimeToDate("", ""), null);
  assertEquals(coopWallTimeToDate("11/19/2026", "08:00"), null);
});

Deno.test("scheduled times read in Central time, whatever the computer's own zone", () => {
  assertEquals(formatCoopDateTime("2026-11-19T14:00:00.000Z"), "Thu, Nov 19 at 8:00 AM CST");
  assertEquals(formatCoopDateTime("2026-07-15T13:00:00.000Z"), "Wed, Jul 15 at 8:00 AM CDT");
});

Deno.test("calendar arithmetic ignores clock changes", () => {
  assertEquals(addCalendarDays("2026-10-31", 2), "2026-11-02");
  assertEquals(addCalendarDays("2026-12-31", 1), "2027-01-01");
  assertEquals(addCalendarDays("2026-03-01", -1), "2026-02-28");
});
