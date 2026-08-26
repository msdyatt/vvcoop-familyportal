import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { buildIcs, byDayCode, IcsEvent } from "../_shared/ics.ts";

/**
 * Serves a subscribable calendar feed -- no interactive login, because a
 * calendar app polling a webcal URL cannot do one. Three scopes:
 *
 *   ?scope=public                 co-op-wide public events, no auth at all
 *   ?scope=class&id=<classId>     one class's weekly meeting time + its
 *                                 dated events -- the class id is already an
 *                                 unguessable uuid and a meeting time isn't
 *                                 sensitive (it doesn't say who's enrolled)
 *   ?scope=personal&token=<token> everything one profile (family or
 *                                 teacher) is entitled to see, resolved by
 *                                 profiles.calendar_token rather than a
 *                                 session -- see regenerate_calendar_token()
 *
 * Uses the service-role client throughout (there is no user session to run
 * RLS as), so the access rules events_read/documents_read normally enforce
 * are re-derived by hand here instead.
 */

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const text = (body: string, status = 200, contentType = "text/calendar; charset=utf-8") =>
  new Response(body, { status, headers: { ...corsHeaders, "Content-Type": contentType } });

/** Where the co-op physically meets. Class meeting times are wall-clock local to this place, not viewer-relative. */
const CALENDAR_TZ = "America/Chicago";

function offsetMinutes(timeZone: string, date: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - date.getTime()) / 60000;
}

/** A wall-clock "YYYY-MM-DD" date plus a Postgres "HH:MM:SS" time in CALENDAR_TZ, as a real UTC instant. */
function localToUtcIso(dateOnly: string, time: string): string {
  const [hour, minute, second] = time.split(":").map(Number);
  const [year, month, day] = dateOnly.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second ?? 0);
  return new Date(guess - offsetMinutes(CALENDAR_TZ, new Date(guess)) * 60000).toISOString();
}

function addDaysDateOnly(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First date on/after `from` (both "YYYY-MM-DD") that falls on `dayOfWeek` (Sunday 0 .. Saturday 6). */
function firstOccurrence(from: string, dayOfWeek: number): string {
  let candidate = from;
  for (let i = 0; i < 7; i += 1) {
    const [year, month, day] = candidate.split("-").map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === dayOfWeek) return candidate;
    candidate = addDaysDateOnly(candidate, 1);
  }
  return from;
}

type AdminClient = ReturnType<typeof createClient>;

/** The date range a class's recurrence should be bounded to: its own terms if it has any, else its whole school year. */
async function classDateRange(admin: AdminClient, classId: string, schoolYearId: string | null): Promise<{ starts: string; ends: string } | null> {
  const { data: termRows } = await admin
    .from("class_terms")
    .select("academic_terms(starts_on,ends_on)")
    .eq("class_id", classId);
  const terms = ((termRows ?? []) as unknown as { academic_terms: { starts_on: string; ends_on: string } | null }[])
    .map((row) => row.academic_terms).filter((term): term is { starts_on: string; ends_on: string } => !!term);
  if (terms.length) {
    return {
      starts: terms.reduce((min, term) => (term.starts_on < min ? term.starts_on : min), terms[0].starts_on),
      ends: terms.reduce((max, term) => (term.ends_on > max ? term.ends_on : max), terms[0].ends_on),
    };
  }
  if (!schoolYearId) return null;
  const { data: year } = await admin.from("school_years").select("starts_on,ends_on").eq("id", schoolYearId).maybeSingle();
  if (!year?.starts_on || !year?.ends_on) return null;
  return { starts: year.starts_on, ends: year.ends_on };
}

/** One recurring VEVENT for a class's weekly meeting block, or null if the class has no block/no date range. */
async function classMeetingEvent(admin: AdminClient, klass: { id: string; title: string; block_id: string | null; room_id: string | null; school_year_id: string | null }): Promise<IcsEvent | null> {
  if (!klass.block_id) return null;
  const [{ data: block }, { data: room }, range] = await Promise.all([
    admin.from("class_blocks").select("day_of_week,starts_at,ends_at").eq("id", klass.block_id).maybeSingle(),
    klass.room_id ? admin.from("rooms").select("name").eq("id", klass.room_id).maybeSingle() : Promise.resolve({ data: null }),
    classDateRange(admin, klass.id, klass.school_year_id),
  ]);
  if (!block || !range) return null;

  const firstDate = firstOccurrence(range.starts, block.day_of_week);
  return {
    uid: `class-${klass.id}@veritasvillage`,
    title: klass.title,
    location: room?.name ?? null,
    startsAt: localToUtcIso(firstDate, block.starts_at),
    endsAt: localToUtcIso(firstDate, block.ends_at),
    allDay: false,
    rrule: { byDay: byDayCode(block.day_of_week), until: localToUtcIso(range.ends, block.ends_at) },
  };
}

type EventRow = { id: string; title: string; description: string | null; location: string | null; starts_at: string; ends_at: string | null; all_day: boolean };

function eventsToIcs(rows: EventRow[]): IcsEvent[] {
  return rows.map((row) => ({
    uid: `event-${row.id}@veritasvillage`,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
  }));
}

const EVENT_SELECT = "id,title,description,location,starts_at,ends_at,all_day";

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return text("Method not allowed", 405, "text/plain");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return text("The calendar feed is not configured.", 500, "text/plain");
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");

  if (scope === "public") {
    const { data } = await admin.from("events").select(EVENT_SELECT).eq("audience", "public").order("starts_at");
    return text(buildIcs(eventsToIcs((data ?? []) as EventRow[]), { name: "Veritas Village" }));
  }

  if (scope === "class") {
    const classId = url.searchParams.get("id");
    if (!classId) return text("Missing class id.", 400, "text/plain");
    const { data: klass } = await admin.from("classes").select("id,title,block_id,room_id,school_year_id").eq("id", classId).eq("active", true).maybeSingle();
    if (!klass) return text("That class was not found.", 404, "text/plain");

    const [meeting, { data: eventRows }] = await Promise.all([
      classMeetingEvent(admin, klass),
      admin.from("events").select(EVENT_SELECT).eq("class_id", classId).eq("audience", "class").order("starts_at"),
    ]);
    const events = eventsToIcs((eventRows ?? []) as EventRow[]);
    return text(buildIcs(meeting ? [meeting, ...events] : events, { name: `Veritas Village – ${klass.title}` }));
  }

  if (scope === "personal") {
    const token = url.searchParams.get("token");
    if (!token) return text("Missing token.", 400, "text/plain");
    const { data: profile } = await admin.from("profiles").select("id,display_name,email").eq("calendar_token", token).maybeSingle();
    if (!profile) return text("That calendar link is no longer valid.", 404, "text/plain");
    const personalName = profile.display_name || profile.email || "My";

    const [{ data: roleRows }, { data: teachingRows }, { data: memberRows }] = await Promise.all([
      admin.from("user_roles").select("role").eq("user_id", profile.id),
      admin.from("teacher_assignments").select("class_id").eq("user_id", profile.id),
      admin.from("family_members").select("family_id").eq("user_id", profile.id),
    ]);
    const roles = new Set((roleRows ?? []).map((row) => row.role as string));
    const teachingClassIds = (teachingRows ?? []).map((row) => row.class_id as string);
    const familyIds = (memberRows ?? []).map((row) => row.family_id as string);

    let familyClassIds: string[] = [];
    if (familyIds.length) {
      const { data: childRows } = await admin.from("children").select("id").in("family_id", familyIds).eq("active", true);
      const childIds = (childRows ?? []).map((row) => row.id as string);
      if (childIds.length) {
        const { data: enrollmentRows } = await admin.from("enrollments").select("class_id").in("child_id", childIds).eq("status", "active");
        familyClassIds = [...new Set((enrollmentRows ?? []).map((row) => row.class_id as string))];
      }
    }
    const classIds = [...new Set([...teachingClassIds, ...familyClassIds])];

    const [classRows, { data: generalEventRows }] = await Promise.all([
      classIds.length
        ? admin.from("classes").select("id,title,block_id,room_id,school_year_id").in("id", classIds).eq("active", true)
        : Promise.resolve({ data: [] as { id: string; title: string; block_id: string | null; room_id: string | null; school_year_id: string | null }[] }),
      admin.from("events").select(EVENT_SELECT + ",audience")
        .in("audience", roles.has("teacher") || roles.has("admin") ? ["public", "families", "teachers"] : ["public", "families"])
        .order("starts_at"),
    ]);

    const classEventLists = await Promise.all((classRows.data ?? []).map(async (klass) => {
      const [meeting, { data: eventRows }] = await Promise.all([
        classMeetingEvent(admin, klass),
        admin.from("events").select(EVENT_SELECT).eq("class_id", klass.id).eq("audience", "class").order("starts_at"),
      ]);
      const events = eventsToIcs((eventRows ?? []) as EventRow[]);
      return meeting ? [meeting, ...events] : events;
    }));

    return text(buildIcs(
      [...classEventLists.flat(), ...eventsToIcs((generalEventRows ?? []) as EventRow[])],
      { name: `${personalName} – Veritas Village` },
    ));
  }

  return text("Unknown calendar scope.", 400, "text/plain");
}

export default {
  async fetch(req: Request) {
    try {
      return await handle(req);
    } catch (error) {
      // A malformed feed is worse than a visible error: a calendar app that
      // gets a 500 with no body just shows "could not refresh," with nothing
      // for anyone to go on.
      return text(error instanceof Error ? `Could not build the calendar: ${error.message}` : "Could not build the calendar.", 500, "text/plain");
    }
  },
};
