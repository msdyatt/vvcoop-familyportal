"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import {
  addDays, dateLabel, dayKey, eventsByDay, fromKey, layoutLanes, minutesOnDay, monthGrid, startOfWeek, timeLabel, whenLabel,
  type CalEvent, type CalView,
} from "../../lib/calendar";
import DetailModal from "./detail-modal";

const VIEWS: { id: CalView; label: string }[] = [
  { id: "month", label: "Month" }, { id: "week", label: "Week" }, { id: "day", label: "Day" }, { id: "list", label: "List" },
];
const COLUMNS = "id,title,description,starts_at,ends_at,location,class_id,audience,all_day,classes(title)";
const VIEW_KEY = "vv-calendar-view";
const HOUR_PX = 52;
const LIST_DAYS = 90;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The span of dates a view shows, as [first day, day after the last]. */
function visibleRange(view: CalView, anchor: Date): [Date, Date] {
  if (view === "month") {
    const grid = monthGrid(anchor.getFullYear(), anchor.getMonth());
    return [grid[0][0], addDays(grid[grid.length - 1][6], 1)];
  }
  if (view === "week") { const start = startOfWeek(anchor); return [start, addDays(start, 7)]; }
  if (view === "day") return [anchor, addDays(anchor, 1)];
  return [anchor, addDays(anchor, LIST_DAYS)];
}

function title(view: CalView, anchor: Date): string {
  if (view === "month") return anchor.toLocaleDateString([], { month: "long", year: "numeric" });
  if (view === "day") return anchor.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (view === "week") {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], sameMonth ? { day: "numeric", year: "numeric" } : { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return "Coming up";
}

/**
 * The family calendar: month, week, day and a plain list. It loads its own
 * events for whatever span is on screen (row-level security decides which
 * events a person can see), and shows class dates alongside co-op dates unless
 * turned off.
 */
export default function CalendarView() {
  const [view, setView] = useState<CalView>(() => {
    try {
      const saved = typeof window === "undefined" ? null : window.localStorage.getItem(VIEW_KEY);
      return saved === "week" || saved === "day" || saved === "list" ? saved : "month";
    } catch { return "month"; }
  });
  const [anchor, setAnchor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showClasses, setShowClasses] = useState(true);
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [open, setOpen] = useState<CalEvent | null>(null);
  const [listDays, setListDays] = useState(LIST_DAYS);

  const [from, to] = useMemo(() => {
    const [start, end] = visibleRange(view, anchor);
    return [start, view === "list" ? addDays(start, listDays) : end] as const;
  }, [view, anchor, listDays]);
  const fromKeyStr = dayKey(from);
  const toKeyStr = dayKey(to);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // Start a month early so an event that began before the span but runs into it is still found.
    const { data } = await supabase.from("events").select(COLUMNS)
      .gte("starts_at", addDays(fromKey(fromKeyStr), -31).toISOString())
      .lt("starts_at", addDays(fromKey(toKeyStr), 1).toISOString())
      .order("starts_at").limit(500);
    setEvents(((data ?? []) as unknown as CalEvent[]));
    setLoaded(true);
  }, [fromKeyStr, toKeyStr]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch when the visible span changes
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => events.filter((event) => showClasses || event.audience !== "class"), [events, showClasses]);
  const byDay = useMemo(() => eventsByDay(shown), [shown]);
  const todayKey = dayKey(new Date());

  function chooseView(next: CalView) {
    setView(next);
    if (next === "list") setAnchor(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12));
    if (next === "day") setAnchor(fromKey(selected));
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* remembered per device only if allowed */ }
  }

  function step(direction: -1 | 1) {
    if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1, 12));
    else if (view === "week") setAnchor(addDays(anchor, 7 * direction));
    else if (view === "day") { const next = addDays(anchor, direction); setAnchor(next); setSelected(dayKey(next)); }
  }

  function today() {
    const now = new Date();
    setAnchor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12));
    setSelected(dayKey(now));
  }

  function goToDay(key: string) {
    setSelected(key);
    setAnchor(fromKey(key));
    setView("day");
  }

  const pill = (event: CalEvent) => <button key={event.id} type="button" className={`cal-pill ${event.audience === "class" ? "class" : "coop"}`} onClick={() => setOpen(event)} title={event.title}>
    {!event.all_day && <i>{timeLabel(event.starts_at)}</i>}{event.title}
  </button>;

  const agendaItem = (event: CalEvent) => <li key={event.id}>
    <button type="button" className={`cal-item ${event.audience === "class" ? "class" : "coop"}`} onClick={() => setOpen(event)}>
      <time>{whenLabel(event)}</time>
      <span><b>{event.title}</b><small>{[event.classes?.title, event.location].filter(Boolean).join(" · ")}</small></span>
    </button>
  </li>;

  const listGroups = useMemo(() => {
    const keys = [...byDay.keys()].filter((key) => key >= dayKey(from) && key < dayKey(to)).sort();
    return keys.map((key) => ({ key, items: byDay.get(key) ?? [] }));
  }, [byDay, from, to]);

  return <div className="cal">
    <div className="cal-head">
      <div className="cal-nav">
        {view !== "list" && <button type="button" className="messages-icon-btn" onClick={() => step(-1)} aria-label="Previous">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
        </button>}
        <button type="button" className="ghost cal-today" onClick={today}>Today</button>
        {view !== "list" && <button type="button" className="messages-icon-btn" onClick={() => step(1)} aria-label="Next">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>}
      </div>
      <h3 className="cal-title" aria-live="polite">{title(view, anchor)}</h3>
      <div className="cal-views" role="tablist" aria-label="Calendar view">
        {VIEWS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? "active" : ""} onClick={() => chooseView(item.id)}>{item.label}</button>)}
      </div>
    </div>
    <label className="cal-filter"><input type="checkbox" checked={showClasses} onChange={(event) => setShowClasses(event.target.checked)} /> Show class dates</label>

    {view === "month" && <>
      <div className="cal-month" role="grid" aria-label={title(view, anchor)}>
        <div className="cal-weekdays" role="row">{DAY_NAMES.map((name) => <span key={name} role="columnheader">{name}</span>)}</div>
        {monthGrid(anchor.getFullYear(), anchor.getMonth()).map((week) => <div key={dayKey(week[0])} className="cal-week-row" role="row">
          {week.map((date) => {
            const key = dayKey(date);
            const items = byDay.get(key) ?? [];
            const inMonth = date.getMonth() === anchor.getMonth();
            return (
              <div key={key} role="gridcell" className={`cal-day${inMonth ? "" : " outside"}${key === todayKey ? " today" : ""}${key === selected ? " selected" : ""}`} onClick={() => setSelected(key)}>
                <button type="button" className="cal-daynum" onClick={() => setSelected(key)} onDoubleClick={() => goToDay(key)} aria-label={`${date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}${items.length ? `, ${items.length} event${items.length === 1 ? "" : "s"}` : ""}`}><span className="cal-num">{date.getDate()}</span></button>
                <div className="cal-pills">
                  {items.slice(0, 3).map(pill)}
                  {items.length > 3 && <button type="button" className="cal-more" onClick={() => goToDay(key)}>+{items.length - 3} more</button>}
                </div>
                {items.length > 0 && <span className="cal-dots" aria-hidden="true">{items.slice(0, 3).map((event) => <i key={event.id} className={event.audience === "class" ? "class" : "coop"} />)}</span>}
              </div>
            );
          })}
        </div>)}
      </div>
      <section className="cal-agenda" aria-label="Selected day">
        <h4>{fromKey(selected).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</h4>
        {(byDay.get(selected) ?? []).length
          ? <ul>{(byDay.get(selected) ?? []).map(agendaItem)}</ul>
          : <p className="portal-empty">{loaded ? "Nothing scheduled." : "Loading…"}</p>}
        <button type="button" className="ghost" onClick={() => goToDay(selected)}>Open this day</button>
      </section>
    </>}

    {view === "week" && <div className="cal-week">
      {Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)).map((date) => {
        const key = dayKey(date);
        const items = byDay.get(key) ?? [];
        return <section key={key} className={`cal-weekday${key === todayKey ? " today" : ""}`} aria-label={date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}>
          <button type="button" className="cal-weekday-head" onClick={() => goToDay(key)}>
            <span>{DAY_NAMES[date.getDay()]}</span><b>{date.getDate()}</b>
          </button>
          {items.length ? <ul>{items.map(agendaItem)}</ul> : <p className="cal-none">{loaded ? "Nothing scheduled" : "Loading…"}</p>}
        </section>;
      })}
    </div>}

    {view === "day" && <DayGrid dateKey={dayKey(anchor)} events={byDay.get(dayKey(anchor)) ?? []} loaded={loaded} onOpen={setOpen} />}

    {view === "list" && <div className="cal-list">
      {listGroups.map(({ key, items }) => <section key={key} className="cal-list-day">
        <h4>{fromKey(key).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}{key === todayKey ? " · Today" : ""}</h4>
        <ul>{items.map(agendaItem)}</ul>
      </section>)}
      {loaded && !listGroups.length && <p className="portal-empty">Nothing is scheduled in the next {listDays} days.</p>}
      {!loaded && <p className="portal-empty">Loading…</p>}
      {loaded && <button type="button" className="ghost" onClick={() => setListDays(listDays + LIST_DAYS)}>Show more</button>}
    </div>}

    {open && <DetailModal title={open.title} onClose={() => setOpen(null)}>
      <p className="portal-empty">{dateLabel(open)}{!open.all_day ? ` · ${whenLabel(open)}` : ""}</p>
      {(open.classes?.title || open.location) && <p className="portal-empty">{[open.classes?.title, open.location].filter(Boolean).join(" · ")}</p>}
      {open.description && <p style={{ whiteSpace: "pre-wrap" }}>{open.description}</p>}
    </DetailModal>}
  </div>;
}

/** One day: all-day events on top, then the hours with timed events placed where they fall. */
function DayGrid({ dateKey, events, loaded, onOpen }: { dateKey: string; events: CalEvent[]; loaded: boolean; onOpen: (event: CalEvent) => void }) {
  const allDay = events.filter((event) => event.all_day);
  const timed = layoutLanes(events.filter((event) => !event.all_day).map((event) => {
    const startMin = minutesOnDay(event.starts_at, dateKey);
    const endRaw = event.ends_at ? minutesOnDay(event.ends_at, dateKey) : startMin + 60;
    return { event, startMin, endMin: Math.max(endRaw, startMin + 30) };
  }));
  const firstHour = Math.min(7, ...timed.map((t) => Math.floor(t.startMin / 60)));
  const lastHour = Math.max(20, ...timed.map((t) => Math.min(24, Math.ceil(t.endMin / 60))));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);

  return <div className="cal-day-view">
    {allDay.length > 0 && <ul className="cal-allday">{allDay.map((event) => <li key={event.id}>
      <button type="button" className={`cal-item ${event.audience === "class" ? "class" : "coop"}`} onClick={() => onOpen(event)}>
        <time>All day</time><span><b>{event.title}</b><small>{[event.classes?.title, event.location].filter(Boolean).join(" · ")}</small></span>
      </button>
    </li>)}</ul>}
    {!events.length && <p className="portal-empty">{loaded ? "Nothing scheduled." : "Loading…"}</p>}
    <div className="cal-hours" style={{ height: hours.length * HOUR_PX }}>
      {hours.map((hour) => <div key={hour} className="cal-hour" style={{ top: (hour - firstHour) * HOUR_PX, height: HOUR_PX }}>
        <span>{new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</span>
      </div>)}
      {timed.map(({ event, startMin, endMin, lane, lanes }) => <button key={event.id} type="button"
        className={`cal-block ${event.audience === "class" ? "class" : "coop"}`}
        style={{
          top: ((startMin - firstHour * 60) / 60) * HOUR_PX,
          height: Math.max(26, ((endMin - startMin) / 60) * HOUR_PX - 2),
          left: `calc(52px + (100% - 56px) * ${lane / lanes})`,
          width: `calc((100% - 56px) / ${lanes} - 3px)`,
        }} onClick={() => onOpen(event)}>
        <b>{event.title}</b><small>{whenLabel(event)}{event.location ? ` · ${event.location}` : ""}</small>
      </button>)}
    </div>
  </div>;
}
