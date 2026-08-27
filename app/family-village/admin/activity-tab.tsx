"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";

type AuditRow = {
  id: number; actor_user_id: string; action: string; subject_type: string;
  subject_id: string; detail: Record<string, unknown> | null; created_at: string; actor_name: string;
};

const RANGES = [
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "all", label: "All time", days: 0 },
];

const PAGE_SIZES = [20, 50, 100];

/**
 * Client-side paging over an already-loaded, already-filtered array -- both
 * views here load one bounded window from Supabase up front (400 / 200 rows)
 * and filter it in memory, so paging that same array is simpler and just as
 * correct as a second round-trip per page would be.
 */
function usePages<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const clamped = Math.min(page, pageCount);
  const start = (clamped - 1) * pageSize;
  return { page: clamped, pageCount, setPage, slice: items.slice(start, start + pageSize) };
}

function Pager({ page, pageCount, pageSize, onPage, onPageSize }: {
  page: number; pageCount: number; pageSize: number; onPage: (page: number) => void; onPageSize: (size: number) => void;
}) {
  if (pageCount <= 1 && pageSize === PAGE_SIZES[0]) return null;
  return <div className="activity-pager">
    <label><span className="field-caption">Per page</span>
      <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
        {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
    <div className="activity-pager-nav">
      <button type="button" className="ghost" onClick={() => onPage(page - 1)} disabled={page <= 1}>Previous</button>
      <span>Page {page} of {pageCount}</span>
      <button type="button" className="ghost" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>Next</button>
    </div>
  </div>;
}

function text(detail: Record<string, unknown> | null, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" && value ? value : null;
}

function num(detail: Record<string, unknown> | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" ? value : null;
}

/**
 * Turns a log row into a sentence.
 *
 * The log used to print its `detail` payload as raw JSON, so reading it meant
 * parsing {"last_name":"Dyatt","display_name":"Dyatt"} by eye. An audit trail is
 * only useful if a person can scan it, so each action gets a phrasing and the
 * payload moves behind a disclosure.
 *
 * Unknown actions fall back to the action name with underscores removed rather
 * than rendering blank -- a new action added elsewhere should degrade to
 * something readable, not disappear.
 */
function describe(row: AuditRow): string {
  const d = row.detail;
  switch (row.action) {
    case "family_updated":
      return `renamed a household to ${text(d, "last_name") ?? text(d, "display_name") ?? "a new name"}`;
    case "household_deleted":
      return `deleted a household after removing ${text(d, "last_adult") ?? "its last adult"}` +
        (num(d, "children") ? `, along with ${num(d, "children")} child record${num(d, "children") === 1 ? "" : "s"}` : "");
    case "child_added":
      return `added ${text(d, "first_name") ?? "a child"} to a household`;
    case "child_updated":
      return `updated ${text(d, "first_name") ?? "a child"}'s record`;
    case "child_deactivated":
      return `marked ${text(d, "first_name") ?? "a child"} inactive`;
    case "user_removed":
      return `removed ${text(d, "display_name") ?? "someone"}'s access to Family Village`;
    case "role_granted":
      return `granted the ${text(d, "role") ?? "a"} role`;
    case "role_revoked":
      return `revoked the ${text(d, "role") ?? "a"} role`;
    case "requirement_opened":
      return `opened "${text(d, "title") ?? "a requirement"}" to ${num(d, "families") ?? "the"} families`;
    case "requirement_status_changed":
      return `updated ${text(d, "family") ?? "a family"} on "${text(d, "requirement") ?? "a requirement"}"`;
    case "signature_link_created":
      return `created a signing link for ${text(d, "family") ?? "a family"} on "${text(d, "requirement") ?? "a document"}"` +
        (text(d, "signer") ? `, sent to ${text(d, "signer")}` : "");
    case "school_year_made_current":
      return `made ${text(d, "label") ?? "a school year"} the current school year`;
    case "reminder_sent":
      return `sent a reminder to ${text(d, "family") ?? "a household"}` +
        (num(d, "items") ? ` about ${num(d, "items")} outstanding item${num(d, "items") === 1 ? "" : "s"}` : "");
    case "child_moved":
      return `moved ${text(d, "first_name") ?? "a child"} from ${text(d, "from") ?? "one household"} to ${text(d, "to") ?? "another"}`;
    case "family_adult_invited":
      return `invited another adult to join ${text(d, "family_name") ?? "a household"}`;
    default:
      return row.action.replace(/_/g, " ");
  }
}

export default function ActivityTab() {
  const [view, setView] = useState<"activity" | "errors">("activity");
  return <section className="activity-log">
    <div className="publishing-switch" role="tablist">
      <button type="button" role="tab" aria-selected={view === "activity"} className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}>Access activity</button>
      <button type="button" role="tab" aria-selected={view === "errors"} className={view === "errors" ? "active" : ""} onClick={() => setView("errors")}>Errors</button>
    </div>
    {view === "activity" ? <AccessActivity /> : <ErrorsView />}
  </section>;
}

function AccessActivity() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [person, setPerson] = useState("all");
  const [action, setAction] = useState("all");
  const [range, setRange] = useState("30");
  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  // Anchored when the data loads rather than read during render: Date.now() in
  // a useMemo is impure, and a window that silently slides while the tab is
  // open would quietly drop rows out from under the reader.
  const [loadedAt, setLoadedAt] = useState(0);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("audit_log")
      .select("id,actor_user_id,action,subject_type,subject_id,detail,created_at")
      .order("created_at", { ascending: false }).limit(400);
    const base = (data ?? []) as Omit<AuditRow, "actor_name">[];
    const actorIds = [...new Set(base.map((row) => row.actor_user_id))];
    const { data: profileRows } = actorIds.length
      ? await supabase.from("profiles").select("id,display_name,email").in("id", actorIds)
      : { data: [] };
    const nameMap = new Map((profileRows ?? []).map((row) => [row.id, row.display_name || row.email]));
    setRows(base.map((row) => ({ ...row, actor_name: nameMap.get(row.actor_user_id) ?? "Someone" })));
    setLoadedAt(Date.now());
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  const people = useMemo(
    () => [...new Map(rows.map((row) => [row.actor_user_id, row.actor_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1])),
    [rows],
  );
  const actions = useMemo(() => [...new Set(rows.map((row) => row.action))].sort(), [rows]);

  const visible = useMemo(() => {
    const days = RANGES.find((option) => option.id === range)?.days ?? 0;
    const cutoff = days && loadedAt ? loadedAt - days * 86_400_000 : 0;
    return rows.filter((row) =>
      (person === "all" || row.actor_user_id === person)
      && (action === "all" || row.action === action)
      && (!cutoff || new Date(row.created_at).getTime() >= cutoff));
  }, [rows, person, action, range, loadedAt]);

  const { page, pageCount, setPage, slice } = usePages(visible, pageSize);

  if (loading) return <p>Loading activity…</p>;

  return <>
    <div className="activity-filters">
      <label><span className="field-caption">Who</span>
        <select value={person} onChange={(event) => { setPerson(event.target.value); setPage(1); }}>
          <option value="all">Anyone</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
      <label><span className="field-caption">What</span>
        <select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}>
          <option value="all">Any action</option>
          {actions.map((value) => <option key={value} value={value}>{value.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label><span className="field-caption">When</span>
        <select value={range} onChange={(event) => { setRange(event.target.value); setPage(1); }}>
          {RANGES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <p className="activity-count">{visible.length} of {rows.length} entries</p>
    </div>

    {visible.length > 0 && <div className="activity-table">
      <div className="activity-row activity-head" aria-hidden="true">
        <span>When</span><span>Activity</span><span></span>
      </div>
      {slice.map((row) => {
        const hasDetail = row.detail && Object.keys(row.detail).length > 0;
        return <div className="activity-row" key={row.id}>
          <time dateTime={row.created_at}>
            {new Date(row.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            <small>{new Date(row.created_at).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}</small>
          </time>
          <div className="activity-line"><b>{row.actor_name}</b> {describe(row)}</div>
          {hasDetail
            ? <button className="activity-detail-toggle" aria-expanded={openDetail === row.id}
                onClick={() => setOpenDetail(openDetail === row.id ? null : row.id)}>
                {openDetail === row.id ? "Hide" : "Details"}
              </button>
            : <span />}
          {hasDetail && openDetail === row.id && <code>{JSON.stringify(row.detail, null, 2)}</code>}
        </div>;
      })}
    </div>}

    <Pager page={page} pageCount={pageCount} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />

    {!visible.length && <p className="portal-empty">
      {rows.length ? "Nothing matches those filters." : "No activity recorded yet."}
    </p>}
  </>;
}

type ErrorRow = {
  id: number; source: string; message: string; stack: string | null;
  url: string | null; context: Record<string, unknown> | null; created_at: string;
};

function ErrorsView() {
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openDetail, setOpenDetail] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("error_log")
      .select("id,source,message,stack,url,context,created_at")
      .order("created_at", { ascending: false }).limit(200);
    setRows((data ?? []) as ErrorRow[]);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { load(); }, []);

  const { page, pageCount, setPage, slice } = usePages(rows, pageSize);

  if (loading) return <p>Loading errors…</p>;

  return <>
    <p className="activity-count">{rows.length} recorded</p>
    {rows.length > 0 && <div className="activity-table">
      <div className="activity-row activity-head" aria-hidden="true">
        <span>When</span><span>Error</span><span></span>
      </div>
      {slice.map((row) => {
        const hasDetail = row.stack || row.context;
        return <div className="activity-row" key={row.id}>
          <time dateTime={row.created_at}>
            {new Date(row.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            <small>{new Date(row.created_at).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}</small>
          </time>
          <div className="activity-line"><b>{row.source}</b> {row.message}{row.url ? <small className="activity-line-url"> — {row.url}</small> : null}</div>
          {hasDetail
            ? <button className="activity-detail-toggle" aria-expanded={openDetail === row.id}
                onClick={() => setOpenDetail(openDetail === row.id ? null : row.id)}>
                {openDetail === row.id ? "Hide" : "Details"}
              </button>
            : <span />}
          {hasDetail && openDetail === row.id && <code>{[row.stack, row.context ? JSON.stringify(row.context, null, 2) : null].filter(Boolean).join("\n\n")}</code>}
        </div>;
      })}
    </div>}
    <Pager page={page} pageCount={pageCount} pageSize={pageSize} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
    {!rows.length && <p className="portal-empty">No errors recorded.</p>}
  </>;
}
