"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Avatar from "../avatar";
import { ChildClassList, ChildDateSections, childName, gradeLabel } from "./child-parts";
import type { ChildrenState } from "./use-children";

/**
 * The Children page: one full section per child, no pop-up to read anything.
 * With more than one child, a list of names picks whose section shows (down
 * the side on a wide screen, tabs across the top on a phone). Editing a child's
 * details is the one thing that still opens a pop-up.
 */
export default function ChildrenSections({ state, onEdit, onEnroll }: {
  state: ChildrenState;
  onEdit: (childId: string) => void;
  onEnroll: (childId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  // A Today card links to /family-village/children?child=<id>. Read once on arrival, as the other portal pages do.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("child");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL is only readable after mount
    if (wanted) setSelectedId(wanted);
  }, []);

  if (state.loading && !state.children.length) return <p className="portal-empty">Loading…</p>;
  if (state.error) return <p className="portal-empty" role="status">{state.error}</p>;
  if (!state.children.length) return null;

  const selected = state.children.find((entry) => entry.child.id === selectedId) ?? state.children[0];
  const several = state.children.length > 1;

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = state.children[(index + step + state.children.length) % state.children.length];
    setSelectedId(next.child.id);
    tabRefs.current.get(next.child.id)?.focus();
  }

  const panelId = `child-panel-${selected.child.id}`;
  return <div className={`children-layout${several ? " has-tabs" : ""}`}>
    {several && <div className="children-tabs" role="tablist" aria-label="Children">
      {state.children.map((entry, index) => {
        const active = entry.child.id === selected.child.id;
        return <button
          key={entry.child.id}
          ref={(node) => { if (node) tabRefs.current.set(entry.child.id, node); else tabRefs.current.delete(entry.child.id); }}
          type="button" role="tab" id={`child-tab-${entry.child.id}`}
          aria-selected={active} aria-controls={active ? panelId : undefined} tabIndex={active ? 0 : -1}
          className={active ? "active" : ""}
          onClick={() => setSelectedId(entry.child.id)}
          onKeyDown={(event) => onTabKey(event, index)}
        >
          <Avatar url={entry.avatarUrl} label={entry.child.first_name} size="sm" />
          <span>{entry.child.first_name}</span>
        </button>;
      })}
    </div>}
    <div className="child-panel" id={panelId} role={several ? "tabpanel" : undefined} aria-labelledby={several ? `child-tab-${selected.child.id}` : undefined}>
      <div className="child-panel-head">
        <Avatar url={selected.avatarUrl} label={selected.child.first_name} size="lg" />
        <div>
          <h3>{childName(selected.child, true)}</h3>
          <small>{gradeLabel(selected.child)}</small>
        </div>
        <div className="row-actions">
          {state.period && <button type="button" className="child-enroll" onClick={() => onEnroll(selected.child.id)}>Enroll</button>}
          <button type="button" className="ghost" onClick={() => onEdit(selected.child.id)}>Edit</button>
        </div>
      </div>
      <section className="child-section">
        <h4 className="card-kicker">Classes</h4>
        <ChildClassList key={selected.child.id} entry={selected} />
      </section>
      <ChildDateSections entry={selected} onToggle={state.toggleCompletion} headingLevel="h4" />
    </div>
  </div>;
}
