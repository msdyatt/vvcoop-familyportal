"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrls } from "../../../lib/storage";
import { shortTime } from "../../../lib/messages";
import DetailModal from "../detail-modal";

type Report = {
  id: string; message_id: string; status: "open" | "actioned" | "dismissed"; reason: string; created_at: string;
  reporter_name: string; sender_name: string; conversation_title: string; conversation_kind: string;
  body: string | null; image_path: string | null; message_deleted: boolean;
};
type ContextRow = { id: string; sender_name: string; body: string | null; image_path: string | null; created_at: string; is_reported: boolean; deleted: boolean };

const STATUS_LABEL = { open: "Needs review", actioned: "Message removed", dismissed: "Dismissed" } as const;

/**
 * Reported messages. This is the only place an administrator reads a private
 * conversation: the reported message and a few around it, and every view and
 * decision is written to the activity log.
 */
export default function MessageReportsTab() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [context, setContext] = useState<{ report: Report; rows: ContextRow[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_message_reports");
    if (error) { setStatus(error.message); setLoaded(true); return; }
    const rows = (data ?? []) as Report[];
    setReports(rows);
    setLoaded(true);
    const paths = rows.map((row) => row.image_path).filter((path): path is string => !!path);
    if (paths.length) setImages(await getSignedFileUrls(supabase, paths));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, [load]);

  async function openContext(report: Report) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_report_context", { p_report_id: report.id });
    if (error) { setStatus(error.message); return; }
    const rows = (data ?? []) as ContextRow[];
    const paths = rows.map((row) => row.image_path).filter((path): path is string => !!path);
    if (paths.length) {
      const urls = await getSignedFileUrls(supabase, paths);
      setImages((previous) => new Map([...previous, ...urls]));
    }
    setContext({ report, rows });
  }

  async function resolve(report: Report, action: "remove" | "dismiss") {
    if (action === "remove" && !confirm("Remove this message for everyone in the conversation? Its text and photo are erased.")) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusyId(report.id); setStatus("");
    const { data, error } = await supabase.rpc("resolve_message_report", { p_report_id: report.id, p_action: action, p_note: null });
    if (error) { setStatus(error.message); setBusyId(null); return; }
    if (typeof data === "string" && data) await supabase.storage.from(PRIVATE_BUCKET).remove([data]);
    setBusyId(null); setContext(null);
    setStatus(action === "remove" ? "The message was removed." : "The report was dismissed.");
    await load();
  }

  const open = reports.filter((report) => report.status === "open");
  const closed = reports.filter((report) => report.status !== "open");

  const card = (report: Report) => <article key={report.id} className="record-card">
    <div className="record-head">
      <b>{report.sender_name}</b>
      <span className={`status-pill ${report.status === "open" ? "outstanding" : ""}`}>{STATUS_LABEL[report.status]}</span>
    </div>
    <p className="portal-empty">In {report.conversation_title} · reported by {report.reporter_name} · {shortTime(report.created_at)}</p>
    <p><b>Reason:</b> {report.reason}</p>
    {report.message_deleted
      ? <p className="portal-empty"><em>The message has been removed.</em></p>
      : <>
          {report.body && <blockquote>{report.body}</blockquote>}
          {report.image_path && images.get(report.image_path) && (
            // eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage
            <img className="messages-report-photo" src={images.get(report.image_path)} alt="Reported photo" />
          )}
        </>}
    <div className="row-actions">
      <button type="button" className="ghost" onClick={() => openContext(report)}>See the conversation around it</button>
      {report.status === "open" && <>
        <button type="button" className="danger" disabled={busyId === report.id || report.message_deleted} onClick={() => resolve(report, "remove")}>Remove message</button>
        <button type="button" className="ghost" disabled={busyId === report.id} onClick={() => resolve(report, "dismiss")}>Dismiss</button>
      </>}
    </div>
  </article>;

  return <section className="admin-section">
    <p className="eyebrow">Messages</p>
    <h2>Reported messages</h2>
    <p className="portal-empty">Private conversations are not browsable. You see a message only when a member reports it, and viewing it is recorded in the activity log.</p>
    {status && <p className="admin-form-status" role="status">{status}</p>}
    {!loaded && <p className="portal-empty">Loading…</p>}
    {loaded && !open.length && <p className="portal-empty">No reports waiting for review.</p>}
    {open.map(card)}
    {closed.length > 0 && <><h3>Handled</h3>{closed.map(card)}</>}

    {context && <DetailModal title="The conversation around the report" onClose={() => setContext(null)}>
      <ul className="messages-context">
        {context.rows.map((row) => <li key={row.id} className={row.is_reported ? "reported" : ""}>
          <b>{row.sender_name}</b> <time>{shortTime(row.created_at)}</time>
          {row.deleted ? <em> Message removed</em> : <>
            {row.body && <p>{row.body}</p>}
            {row.image_path && images.get(row.image_path) && (
              // eslint-disable-next-line @next/next/no-img-element -- a signed link to private storage
              <img className="messages-report-photo" src={images.get(row.image_path)} alt="Photo in the conversation" />
            )}
          </>}
        </li>)}
      </ul>
    </DetailModal>}
  </section>;
}
