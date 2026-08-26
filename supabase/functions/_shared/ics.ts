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
  /** ISO timestamp. For an all-day event, only the date portion is used. */
  startsAt: string;
  endsAt?: string | null;
  allDay: boolean;
  /** Set for a recurring class meeting block. */
  rrule?: {
    byDay: string; // e.g. "FR"
    /** ISO timestamp -- the last date the recurrence can land on. */
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

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function buildEvent(event: IcsEvent, stamp: string): string[] {
  const lines: string[] = ["BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp}`];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.startsAt)}`);
    // DTEND is exclusive for an all-day event -- one day after the last day it covers.
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(addDays(event.endsAt ?? event.startsAt, 1))}`);
  } else {
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

/** Renders a full VCALENDAR document, ready to serve as text/calendar. */
export function buildIcs(events: IcsEvent[]): string {
  const stamp = formatDateTime(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veritas Village//Family Portal//EN",
    "CALSCALE:GREGORIAN",
    ...events.flatMap((event) => buildEvent(event, stamp)),
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Postgres day-of-week (Sunday 0 .. Saturday 6) to the two-letter RRULE BYDAY code. */
export function byDayCode(dayOfWeek: number): string {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][dayOfWeek] ?? "MO";
}
