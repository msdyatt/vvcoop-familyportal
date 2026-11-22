"use client";

import Avatar from "../avatar";
import { classStartLabel, formatCoopDay, nextCoopDay, teacherLine } from "../../../lib/children-view";
import { AssignmentCheck, childName } from "./child-parts";
import { localToday, type ChildOverview } from "./use-children";

/**
 * A child on Today: their next co-op day only (classes with time and teacher),
 * any assignment due by then with its tick box, and Enroll while a window is
 * open. The name goes to the child's section on the Children page; nothing here
 * opens a pop-up.
 */
export default function ChildCard({ entry, canEnroll, onToggle, onEnroll }: {
  entry: ChildOverview;
  canEnroll: boolean;
  onToggle: (childId: string, eventId: string, done: boolean) => Promise<string>;
  onEnroll: (childId: string) => void;
}) {
  const today = localToday();
  const next = nextCoopDay(entry.classes, entry.dates, today);
  const name = childName(entry.child);
  return <article className="child-today" aria-label={name}>
    <div className="child-today-head">
      <Avatar url={entry.avatarUrl} label={entry.child.first_name} />
      <h3><a href={`/family-village/children?child=${entry.child.id}`}>{name}</a></h3>
      {canEnroll && <button type="button" className="child-enroll" onClick={() => onEnroll(entry.child.id)}>Enroll</button>}
    </div>
    {!entry.classes.length
      ? <p className="portal-empty">No classes yet.</p>
      : next.day
        ? <>
            <p className="child-today-day">{next.day === today ? `Today, ${formatCoopDay(next.day).split(", ")[1]}` : formatCoopDay(next.day)}</p>
            <ul className="child-today-classes">{next.classes.map((row) => {
              const teachers = teacherLine(row.teachers);
              return <li key={row.id}>
                <time>{classStartLabel(row) || "Time TBA"}</time>
                <span><b>{row.title}</b>{teachers && <small>{teachers}</small>}</span>
              </li>;
            })}</ul>
          </>
        : <p className="portal-empty">No co-op days on the schedule.</p>}
    {next.assignments.length > 0 && <ul className="child-assignments">
      {next.assignments.map((row) => <AssignmentCheck key={row.id} row={row} childId={entry.child.id} onToggle={onToggle} />)}
    </ul>}
  </article>;
}
