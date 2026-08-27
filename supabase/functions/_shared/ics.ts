/**
 * A small, hand-rolled RFC 5545 (iCalendar) writer.
 *
 * No npm package for this exists in the project and the format itself is
 * simple text, so this stays dependency-free like the rest of the edge
 * functions. Only what a subscribed calendar actually needs is implemented:
 * plain events, all-day events, and one weekly-recurring event per class
 * meeting block (RRULE) rather than a row per week.
 */

export type IcsEvent = {
  /** Stable across regenerations of the same feed, or a client's calendar app treats every refresh as a new event. */
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO timestamp. For an all-day event, only the date portion is used. Unused (and optional) when `local` is set. */
  startsAt?: string;
  endsAt?: string | null;
  allDay: boolean;
  /**
   * A wall-clock time in a named zone, for a weekly class meeting that must
   * stay at the same clock time when the zone's UTC offset changes at a
   * daylight-saving transition. When set, DTSTART/DTEND are written as local
   * times tagged with TZID and buildIcs emits a matching VTIMEZONE -- a bare
   * UTC DTSTART with a weekly RRULE would instead be expanded by a fixed
   * 168-hour step and land an hour off for every occurrence after the change.
   */
  local?: {
    /** IANA zone name; buildIcs must have a VTIMEZONE defined for it. */
    tzid: string;
    /** Naive wall-clock, no offset or "Z": "2026-09-04T14:00:00". */
    startsAt: string;
    /** Naive wall-clock, no offset or "Z". */
    endsAt: string;
  };
  /** Set for a recurring class meeting block. */
  rrule?: {
    byDay: string; // e.g. "FR"
    /** ISO timestamp -- the last start instant the recurrence can land on. Kept in UTC even for a `local` event, per RFC 5545 3.3.10. */
    until: string;
  };
};

/** Escapes TEXT property values per RFC 5545 4.3.11 -- backslash, then the characters it introduces. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets with the CRLF + single-space continuation RFC 5545 3.1 requires. */
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length) {
    const limit = first ? 75 : 74; // continuation lines lose one column to their leading space
    let cut = Math.min(limit, rest.length);
    // Never split a multi-byte UTF-16 surrogate pair across chunks.
    if (cut < rest.length && rest.charCodeAt(cut - 1) >= 0xd800 && rest.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    first = false;
  }
  return chunks.join("\r\n ");
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** "20260901" for an all-day DTSTART/DTEND. */
function formatDateOnly(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

/** "20260901T140000Z" for a timed DTSTART/DTEND/UNTIL. */
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * "2026-09-04T14:00:00" -> "20260904T140000", by string surgery only. A naive
 * wall-clock string must never be routed through `new Date()`: that reads it in
 * whatever zone the runtime happens to be in and shifts the result.
 */
function formatLocalDateTime(naive: string): string {
  const match = naive.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) throw new Error(`ics: not a naive local date-time: ${JSON.stringify(naive)}`);
  const [, year, month, day, hour, minute, second] = match;
  return `${year}${pad(+month)}${pad(+day)}T${pad(+hour)}${pad(+minute)}${pad(+(second ?? 0))}`;
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function buildEvent(event: IcsEvent, stamp: string): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp}`];

  if (event.local) {
    // Local wall time + TZID, so a subscribing app expands the RRULE by this
    // zone's DST rules (see VTIMEZONE_BLOCKS) rather than a frozen UTC offset.
    lines.push(`DTSTART;TZID=${event.local.tzid}:${formatLocalDateTime(event.local.startsAt)}`);
    lines.push(`DTEND;TZID=${event.local.tzid}:${formatLocalDateTime(event.local.endsAt)}`);
  } else if (event.allDay) {
    if (!event.startsAt) throw new Error("ics: an all-day event needs startsAt");
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.startsAt)}`);
    // DTEND is exclusive for an all-day event -- one day after the last day it covers.
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(addDays(event.endsAt ?? event.startsAt, 1))}`);
  } else {
    if (!event.startsAt) throw new Error("ics: a timed event needs startsAt");
    lines.push(`DTSTART:${formatDateTime(event.startsAt)}`);
    if (event.endsAt) lines.push(`DTEND:${formatDateTime(event.endsAt)}`);
  }

  if (event.rrule) lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${event.rrule.byDay};UNTIL=${formatDateTime(event.rrule.until)}`);

  lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * VTIMEZONE bodies for every zone a `local` event may name. Emitted into the
 * VCALENDAR whenever some event references the zone, so a subscribing app has
 * the DST transition rules on hand to expand a weekly RRULE by wall clock.
 *
 * America/Chicago is given under the U.S. rule in force since 2007: CDT
 * (UTC-5) from 02:00 on the second Sunday of March, CST (UTC-6) from 02:00 on
 * the first Sunday of November. The 2007 DTSTART is just a real anchor instance
 * of each yearly rule -- only the RRULE and offsets are consulted for the
 * years a class actually meets.
 */
const VTIMEZONE_BLOCKS: Record<string, string[]> = {
  "America/Chicago": [
    "BEGIN:VTIMEZONE",
    "TZID:America/Chicago",
    "BEGIN:DAYLIGHT",
    "DTSTART:20070311T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "TZOFFSETFROM:-0600",
    "TZOFFSETTO:-0500",
    "TZNAME:CDT",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "DTSTART:20071104T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0600",
    "TZNAME:CST",
    "END:STANDARD",
    "END:VTIMEZONE",
  ],
};

/**
 * Renders a full VCALENDAR document, ready to serve as text/calendar.
 *
 * X-WR-CALNAME (and X-WR-CALDESC) are non-standard but universally
 * respected by Apple Calendar, Google Calendar, and Outlook -- it's what
 * names the calendar in the subscriber's own sidebar. Without it, a
 * subscribed feed shows up labeled with the raw feed URL or "Untitled",
 * indistinguishable from any other calendar someone has subscribed to.
 */
export function buildIcs(events: IcsEvent[], calendar: { name: string; description?: string }): string {
  const stamp = formatDateTime(new Date().toISOString());
  const tzids = [...new Set(events.flatMap((event) => (event.local ? [event.local.tzid] : [])))];
  const vtimezoneLines = tzids.flatMap((tzid) => {
    const block = VTIMEZONE_BLOCKS[tzid];
    if (!block) throw new Error(`ics: no VTIMEZONE defined for ${tzid}`);
    return block;
  });
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veritas Village//Family Portal//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    ...(calendar.description ? [`X-WR-CALDESC:${escapeText(calendar.description)}`] : []),
    // VTIMEZONE components precede the VEVENTs that reference them, as every
    // real-world producer emits them and some parsers assume it.
    ...vtimezoneLines,
    ...events.flatMap((event) => buildEvent(event, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Postgres day-of-week (Sunday 0 .. Saturday 6) to the two-letter RRULE BYDAY code. */
export function byDayCode(dayOfWeek: number): string {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dayOfWeek] ?? "MO";
}
