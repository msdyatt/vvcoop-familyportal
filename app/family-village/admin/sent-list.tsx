"use client";

import { useCallback, useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { getSignedFileUrl } from "../../../lib/storage";
import {
  REQUEST_COLUMNS, formatSignedAt, friendlyError, requestSeal, requestStatusLabel, signerStatusLabel, statusTone,
  type SignRequest,
} from "../../../lib/sign";

type Row = SignRequest & {
  families: { display_name: string } | null;
  sign_signers: { id: string; slot: number; display_name: string; status: "pending" | "viewed" | "consented" | "signed"; signed_at: string | null; user_id: string | null }[];
};
type EventRow = { id: number; action: string; actor_name: string | null; ip: string | null; user_agent: string | null; created_at: string; detail: Record<string, unknown> };

const ACTION_LABEL: Record<string, string> = {
  created: "Created", sent: "Sent", viewed: "Opened", consent_given: "Agreed to sign electronically", field_filled: "Filled in a field",
  signed: "Signed", completed: "Sealed", voided: "Voided", downloaded: "Downloaded", reminded: "Reminder sent",
  timestamped: "Trusted timestamp", seal_failed: "Sealing failed",
};

/**
 * Every document that has been sent, who has signed it and what has happened.
 * Remind, void, finish sealing, download, and read the audit trail.
 */
export default function SentList({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<"open" | "completed" | "voided" | "all">("open");
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("sign_requests")
      .select(`${REQUEST_COLUMNS},families(display_name),sign_signers(id,slot,display_name,status,signed_at,user_id)`)
      .order("created_at", { ascending: false }).limit(200);
    setRows((data ?? []) as unknown as Row[]);
    setLoaded(true);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
  useEffect(() => { load(); }, [load, refreshKey]);

  async function loadEvents(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("sign_events").select("id,action,actor_name,ip,user_agent,created_at,detail").eq("request_id", id).order("id");
    setEvents((data ?? []) as EventRow[]);
  }
  async function toggle(id: string) {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    await loadEvents(id);
  }

  async function run(row: Row, action: "remind" | "void" | "seal" | "download") {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setMessage("");
    if (action === "void") {
      const reason = window.prompt(`Why is “${row.title}” for ${row.families?.display_name ?? "this household"} being cancelled? The signers will see this.`);
      if (!reason?.trim()) return;
      setBusyId(row.id);
      const { error } = await supabase.rpc("sign_void", { p_request: row.id, p_reason: reason.trim() });
      setBusyId(null);
      setMessage(error ? friendlyError(error) : "Cancelled. The household owes the document again.");
    } else if (action === "remind") {
      setBusyId(row.id);
      const { data, error } = await supabase.rpc("sign_remind", { p_request: row.id });
      setBusyId(null);
      setMessage(error ? friendlyError(error) : data === 0 ? "No reminder sent: everyone whose turn it is was reminded in the last hour." : `Reminder sent to ${data} ${data === 1 ? "person" : "people"}.`);
    } else if (action === "seal") {
      setBusyId(row.id);
      const sealed = await requestSeal(supabase, row.id);
      setBusyId(null);
      setMessage(sealed.ok ? "The signed copy is ready." : sealed.message ?? "It could not be finished. Try again in a minute.");
    } else if (row.sealed_path) {
      await supabase.rpc("sign_log_download", { p_request: row.id, p_what: "sealed" });
      const url = await getSignedFileUrl(supabase, row.sealed_path, 300);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    }
    await load();
    if (openId === row.id) await loadEvents(row.id);
  }

  const shown = rows.filter((r) => filter === "all" || (filter === "open" ? ["sent", "in_progress", "signed"].includes(r.status) : r.status === filter));

  return <section className="sent-list" aria-label="Documents sent for signature">
    <div className="sent-list-head">
      <h2>Sent for signature</h2>
      <label><span className="field-caption">Show</span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="open">Waiting</option><option value="completed">Signed and sealed</option><option value="voided">Cancelled</option><option value="all">Everything</option>
        </select></label>
    </div>
    {message && <p className="admin-form-status" role="status">{message}</p>}
    {!loaded && <p className="portal-empty">Loading…</p>}
    {loaded && !shown.length && <p className="portal-empty">Nothing here.</p>}
    <ul className="sent-rows">
      {shown.map((row) => <li key={row.id} className="sent-row">
        <div className="sent-row-main">
          <b>{row.title}</b>
          <span>{row.families?.display_name ?? "Household removed"} · sent {formatSignedAt(row.created_at)}{row.due_on ? ` · due ${row.due_on}` : ""}</span>
          <span className="sent-signers">{[...row.sign_signers].sort((a, b) => a.slot - b.slot).map((s) =>
            <span key={s.id} className={`status-pill ${statusTone(s.status)}`}>{s.display_name}: {signerStatusLabel(s.status)}</span>)}</span>
        </div>
        <span className={`status-pill ${statusTone(row.status)}`}>{requestStatusLabel(row.status)}</span>
        <div className="sent-actions">
          {(row.status === "sent" || row.status === "in_progress") && <button type="button" className="ghost" disabled={busyId === row.id} onClick={() => run(row, "remind")}>Remind</button>}
          {row.status === "signed" && <button type="button" className="ghost" disabled={busyId === row.id} onClick={() => run(row, "seal")}>{row.seal_error ? "Try sealing again" : "Finish sealing"}</button>}
          {row.status === "completed" && <button type="button" className="ghost" onClick={() => run(row, "download")}>Download signed PDF</button>}
          {row.status !== "completed" && row.status !== "voided" && <button type="button" className="danger" disabled={busyId === row.id} onClick={() => run(row, "void")}>Cancel</button>}
          <button type="button" className="ghost" aria-expanded={openId === row.id} onClick={() => toggle(row.id)}>{openId === row.id ? "Hide history" : "History"}</button>
        </div>
        {row.seal_error && row.status === "signed" && <p className="sign-hint" role="status">Sealing failed: {row.seal_error}</p>}
        {row.status === "voided" && row.void_reason && <p className="sign-hint">Cancelled: {row.void_reason}</p>}
        {openId === row.id && <table className="sent-events">
          <caption className="sr-only">Audit trail</caption>
          <thead><tr><th>Time</th><th>What</th><th>Who</th><th>IP address</th></tr></thead>
          <tbody>{events.map((e) => <tr key={e.id}>
            <td>{formatSignedAt(e.created_at)}</td><td>{ACTION_LABEL[e.action] ?? e.action}</td><td>{e.actor_name ?? ""}</td><td>{e.ip ?? ""}</td>
          </tr>)}</tbody>
        </table>}
      </li>)}
    </ul>
  </section>;
}
