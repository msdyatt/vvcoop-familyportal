/**
 * Manual end-to-end verification for the two calendar-feed fixes, using a real
 * iCalendar parser (ical.js, the engine behind Thunderbird's calendar) as a
 * stand-in for "subscribe a real calendar app". Not part of `deno test` -- it
 * pulls an npm package the committed suite deliberately avoids.
 *
 *   deno run --node-modules-dir=auto -A supabase/functions/calendar-feed/feed.dst-check.ts
 *
 * It builds the feed for a class assigned to a Fall and a Spring term that
 * meets Fridays 2:00-3:30pm, expands every occurrence with ical.js, and checks:
 *
 *   - every occurrence starts at 14:00 America/Chicago, including the ones
 *     after the Nov 2026 fall-back and the Mar 2027 spring-forward (the DST
 *     drift bug put those an hour off);
 *   - no occurrence lands in the winter break between the two terms (the
 *     multi-term gap bug met every week straight through it).
 *
 * It then rebuilds the feed the old way (one bare-UTC VEVENT over the whole
 * min..max span) and shows ical.js reproducing both faults, so the checks
 * above are known to be load-bearing.
 */

import ICAL from "npm:ical.js@2";
import { buildIcs, IcsEvent } from "../_shared/ics.ts";
import { mergeContiguousRanges } from "../_shared/date-ranges.ts";
import { buildClassMeetingEvents } from "./index.ts";

const TZ = "America/Chicago";
const FALL = { starts: "2026-08-24", ends: "2026-12-18" };
const SPRING = { starts: "2027-01-05", ends: "2027-05-22" };
const BLOCK = { day_of_week: 5, starts_at: "14:00:00", ends_at: "15:30:00" }; // Friday 2:00-3:30pm

const wallClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** A UTC instant -> "YYYY-MM-DD HH:MM" as read on a clock in America/Chicago. */
function inChicago(date: Date): { day: string; time: string } {
  const p = Object.fromEntries(wallClock.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Expand every VEVENT in an ICS document between two dates, as a calendar app would. */
function expand(ics: string, fromIso: string, toIso: string): { uid: string; day: string; time: string }[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vt of root.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(vt);
    if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone.tzid, zone);
  }
  const from = ICAL.Time.fromDateTimeString(fromIso);
  const to = ICAL.Time.fromDateTimeString(toIso);
  const out: { uid: string; day: string; time: string }[] = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const event = new ICAL.Event(ve);
    const it = event.iterator();
    for (let guard = 0; guard < 400; guard += 1) {
      const next = it.next();
      if (!next) break;
      if (next.compare(from) < 0) continue;
      if (next.compare(to) > 0) break;
      const { day, time } = inChicago(next.toJSDate());
      out.push({ uid: event.uid, day, time });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Every Friday in [spanStart, spanEnd], inclusive -- the occurrences a weekly Friday RRULE bounded to that span should produce. */
function fridaysInSpan(spanStart: string, spanEnd: string): string[] {
  const days: string[] = [];
  const d = new Date(`${spanStart}T00:00:00Z`);
  const end = new Date(`${spanEnd}T00:00:00Z`);
  while (d <= end) {
    if (d.getUTCDay() === 5) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// --- the fixed feed ------------------------------------------------------

const spans = mergeContiguousRanges([FALL, SPRING]);
const events: IcsEvent[] = buildClassMeetingEvents({ id: "demo", title: "Pottery" }, BLOCK, "Room A", spans);
const ics = buildIcs(events, { name: "Veritas Village – Pottery" });

console.log("=== generated feed ===");
console.log(ics.replace(/\r\n/g, "\n"));

const occ = expand(ics, "2026-08-01T00:00:00", "2027-06-15T00:00:00");
const expected = [
  ...fridaysInSpan(FALL.starts, FALL.ends),
  ...fridaysInSpan(SPRING.starts, SPRING.ends),
];

console.log("\n=== checks: fixed feed ===");
check("two VEVENTs, one per contiguous term span", events.length === 2, `got ${events.length}`);
check("occurrence count matches the Fridays in each term", occ.length === expected.length, `got ${occ.length}, expected ${expected.length}`);
check("occurrence dates match the Fridays in each term", JSON.stringify(occ.map((o) => o.day)) === JSON.stringify(expected));

const offTime = occ.filter((o) => o.time !== "14:00");
check("every occurrence starts at 14:00 America/Chicago (DST-safe)", offTime.length === 0,
  offTime.length ? offTime.slice(0, 5).map((o) => `${o.day} @ ${o.time}`).join(", ") : "");

const afterFallBack = occ.filter((o) => o.day >= "2026-11-01");
check("post-DST occurrences present and still 14:00", afterFallBack.length > 0 && afterFallBack.every((o) => o.time === "14:00"),
  `${afterFallBack.length} occurrences from Nov 2026 on`);

const inGap = occ.filter((o) => o.day > FALL.ends && o.day < SPRING.starts);
check("no occurrence in the winter break between terms", inGap.length === 0,
  inGap.map((o) => o.day).join(", "));

// --- the pre-fix feed, to prove the checks would catch a regression ----

function zonedToUtcIso(day: string, time: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  const guessUtc = Date.UTC(y, m - 1, d, hh, mm, ss ?? 0);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(guessUtc)).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guessUtc - (asUtc - guessUtc)).toISOString();
}

const oldStart = "2026-08-28";
const oldIcs = buildIcs([{
  uid: "class-demo@veritasvillage",
  title: "Pottery",
  location: "Room A",
  allDay: false,
  startsAt: zonedToUtcIso(oldStart, BLOCK.starts_at),
  endsAt: zonedToUtcIso(oldStart, BLOCK.ends_at),
  rrule: { byDay: "FR", until: zonedToUtcIso(SPRING.ends, BLOCK.ends_at) },
}], { name: "old" });

const oldOcc = expand(oldIcs, "2026-08-01T00:00:00", "2027-06-15T00:00:00");
const oldDrift = oldOcc.filter((o) => o.time !== "14:00");
const oldGap = oldOcc.filter((o) => o.day > FALL.ends && o.day < SPRING.starts);

console.log("\n=== the pre-fix feed reproduces both bugs (sanity) ===");
check("pre-fix: some occurrences drift off 14:00 after the DST change", oldDrift.length > 0,
  `${oldDrift.length} drifted, e.g. ${oldDrift.slice(0, 3).map((o) => `${o.day} @ ${o.time}`).join(", ")}`);
check("pre-fix: occurrences appear during the winter break", oldGap.length > 0,
  `${oldGap.length} in-gap, e.g. ${oldGap.slice(0, 3).map((o) => o.day).join(", ")}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (failures) Deno.exit(1);
