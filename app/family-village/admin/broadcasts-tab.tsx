"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import {
  SEVERITIES, audienceReady, describeExtras, describePreview, looksUnfinished, previewKey,
  type Audience, type Preview, type Severity,
} from "../../../lib/broadcast";
import { CollapsibleRecord, ConfirmDeleteModal, GRADES } from "./admin-ui";

type Template = { id: string; name: string; severity: Severity; title: string; body: string; builtin: boolean };
type ClassRow = { id: string; title: string };
type Person = { id: string; display_name: string | null; email: string };
type HistoryRow = {
  id: string; title: string; severity: Severity; audience_label: string | null; created_at: string; sent_by: string | null;
  recipient_count: number; reached: number; acked: number; active: boolean;
};
type PersonReport = {
  user_id: string; name: string; reached: boolean; seen: boolean; acked: boolean;
  push: string | null; push_reason: string | null; email_status: string | null; email_reason: string | null; sms: string | null; sms_reason: string | null;
};
type Report = {
  id: string; severity: Severity; active: boolean; recipients: number; reached: number; not_reached: number; seen: number; acked: number;
  channels: Record<"push" | "email" | "sms", Record<string, number>>; people: PersonReport[];
};

const REASONS: Record<string, string> = {
  no_device: "no phone notifications set up", push_disabled: "push turned off", quiet_mode: "wants only urgent things",
  seen_meanwhile: "already read it", inactive: "account not active", email_off: "email turned off",
  sms_not_allowed: "no text agreement", phone_changed: "number changed", expired: "waited too long to send",
  provider_not_set_up: "texting is not set up yet", not_on_allowlist: "held back (dry run)", send_failed: "the send failed",
  interrupted: "the send was interrupted",
};
const why = (reason: string | null) => (reason ? (REASONS[reason] ?? reason.replace(/_/g, " ")) : "");

/** The admin's own account, to prefill nothing: just a fresh id for each composed message. */
const newRequestId = () => crypto.randomUUID();

export default function BroadcastsTab() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("notice");
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>({ type: "everyone" });
  const [search, setSearch] = useState("");
  const [templateName, setTemplateName] = useState("");

  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [sentNote, setSentNote] = useState("");
  const [confirmUrgent, setConfirmUrgent] = useState(false);
  // One id per composed message: pressing Send twice, or retrying after a timeout, can only ever send once.
  const requestId = useRef(newRequestId());

  const loadHistory = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.rpc("admin_broadcast_history", { p_limit: 30 });
    setHistory(((data ?? []) as HistoryRow[]).map((row) => ({ ...row, reached: Number(row.reached), acked: Number(row.acked) })));
  }, []);

  const loadTemplates = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data } = await supabase.from("broadcast_templates").select("id,name,severity,title,body,builtin").order("builtin", { ascending: false }).order("name");
    setTemplates((data ?? []) as Template[]);
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    void loadHistory();
    void loadTemplates();
    void supabase.from("classes").select("id,title").eq("active", true).order("title").then(({ data }) => setClasses((data ?? []) as ClassRow[]));
    void supabase.from("profiles").select("id,display_name,email").eq("status", "active").eq("is_demo", false).order("display_name").then(({ data }) => setPeople((data ?? []) as Person[]));
  }, [loadHistory, loadTemplates]);

  const key = previewKey(audience, severity);
  const previewFresh = preview?.key === key;
  const ready = title.trim() !== "" && body.trim() !== "" && audienceReady(audience);

  const picked = audience.type === "people" ? audience.user_ids : [];
  const shownPeople = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return people.filter((p) => !needle || `${p.display_name ?? ""} ${p.email}`.toLowerCase().includes(needle)).slice(0, 60);
  }, [people, search]);

  function chooseTemplate(id: string) {
    const t = templates.find((row) => row.id === id);
    if (!t) { setTemplateKey(null); return; }
    setTemplateKey(t.name); setTitle(t.title); setBody(t.body); setSeverity(t.severity);
  }

  async function saveTemplate() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !templateName.trim()) return;
    setBusy(true); setStatus("");
    const { error } = await supabase.rpc("admin_save_broadcast_template", { p_name: templateName.trim(), p_severity: severity, p_title: title, p_body: body });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setTemplateName(""); setStatus(`Saved the template “${templateName.trim()}”.`);
    await loadTemplates();
  }

  async function deleteTemplate(id: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    await supabase.rpc("admin_delete_broadcast_template", { p_id: id });
    await loadTemplates();
  }

  async function runPreview() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setStatus(""); setSentNote("");
    const { data, error } = await supabase.rpc("admin_broadcast_preview", { p_audience: audience, p_severity: severity });
    setBusy(false);
    if (error) { setStatus(error.message); return; }
    setPreview({ key, data: data as Preview });
  }

  async function send() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !preview) return;
    setBusy(true); setStatus("");
    const { data, error } = await supabase.rpc("admin_send_broadcast", {
      p_request_id: requestId.current, p_title: title, p_body: body, p_severity: severity, p_audience: audience,
      p_template_key: templateKey, p_confirm_urgent: severity === "urgent",
    });
    setBusy(false); setConfirmUrgent(false);
    if (error) { setStatus(error.message); return; }
    const result = data as { recipients: number; duplicate: boolean };
    setSentNote(result.duplicate
      ? `Already sent: this message went out to ${result.recipients} people a moment ago. Nothing was sent twice.`
      : `${severity === "urgent" ? "Urgent alert sent" : "Sent"} to ${result.recipients} ${result.recipients === 1 ? "person" : "people"}. Phone notifications go out within a minute${severity === "urgent" ? ", with emails and texts right behind" : ""}.`);
    // A new message gets a new id, so the next send is a different broadcast.
    requestId.current = newRequestId();
    setTitle(""); setBody(""); setTemplateKey(null); setPreview(null);
    await loadHistory();
  }

  function startSend() {
    if (!preview || !previewFresh) return;
    if (looksUnfinished(`${title} ${body}`) && !confirm("This still looks like it has a placeholder in it (something in [brackets] or “TBD”). Send it anyway?")) return;
    if (severity === "urgent") { setConfirmUrgent(true); return; }
    if (confirm(`Send “${title.trim()}” to ${describePreview(preview.data)}?`)) void send();
  }

  return <section className="broadcasts-tab">
    <div className="admin-section-head">
      <p className="eyebrow">Broadcasts</p>
      <h2>Tell everyone, or just the people who need to know</h2>
      <p className="field-note">Use Urgent only for things like a closure. It goes out right away on every channel each person allows, and shows a banner until they tap Got it.</p>
    </div>

    <article className="integration-card broadcast-composer">
      <div className="integration-card-head"><h3>New broadcast</h3></div>
      <div className="household-form">
        <label>Start from a template
          <select value={templates.find((t) => t.name === templateKey)?.id ?? ""} onChange={(event) => chooseTemplate(event.target.value)} disabled={busy}>
            <option value="">None</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? "" : " (saved)"}</option>)}
          </select>
        </label>

        <fieldset className="broadcast-severity">
          <legend>How serious</legend>
          {SEVERITIES.map((s) => <label key={s.value} className={`checkbox-field broadcast-severity-${s.value}${severity === s.value ? " on" : ""}`}>
            <input type="radio" name="severity" checked={severity === s.value} disabled={busy} onChange={() => setSeverity(s.value)} />
            <b>{s.label}</b>
            <span className="field-note">{s.hint}</span>
          </label>)}
        </fieldset>

        <label>Title<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Closed today because of the weather" disabled={busy} /></label>
        <label>Message<textarea value={body} maxLength={2000} rows={5} onChange={(event) => setBody(event.target.value)} placeholder="What people need to know and do." disabled={busy} /></label>

        <label>Who is it for
          <select value={audience.type} disabled={busy} onChange={(event) => {
            const type = event.target.value as Audience["type"];
            setAudience(type === "class" ? { type, class_id: "" } : type === "grade" ? { type, grade: "" } : type === "people" ? { type, user_ids: [] } : { type });
          }}>
            <option value="everyone">Everyone</option>
            <option value="class">A class (its families and teachers)</option>
            <option value="grade">A grade (parents of children in it)</option>
            <option value="teachers">All teachers</option>
            <option value="people">Hand-picked people</option>
          </select>
        </label>
        {audience.type === "class" && <label>Class
          <select value={audience.class_id} disabled={busy} onChange={(event) => setAudience({ type: "class", class_id: event.target.value })}>
            <option value="">Choose a class</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>}
        {audience.type === "grade" && <label>Grade
          <select value={audience.grade} disabled={busy} onChange={(event) => setAudience({ type: "grade", grade: event.target.value })}>
            <option value="">Choose a grade</option>
            {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>}
        {audience.type === "people" && <div className="broadcast-people">
          <label>Find people<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or email" disabled={busy} /></label>
          <p className="field-note">{picked.length} chosen</p>
          <ul>
            {shownPeople.map((p) => <li key={p.id}>
              <label className="checkbox-field">
                <input type="checkbox" checked={picked.includes(p.id)} disabled={busy}
                  onChange={(event) => setAudience({ type: "people", user_ids: event.target.checked ? [...picked, p.id] : picked.filter((id) => id !== p.id) })} />
                <b>{p.display_name || p.email}</b>
                {p.display_name && <span className="field-note">{p.email}</span>}
              </label>
            </li>)}
          </ul>
        </div>}

        <div className="print-queue-actions">
          <button type="button" className="ghost" disabled={busy || !ready} onClick={() => void runPreview()}>{busy ? "Working…" : "Preview who will be reached"}</button>
        </div>

        {preview && <div className={`broadcast-preview${previewFresh ? "" : " stale"}`} role="status">
          <p className="broadcast-preview-headline">{describePreview(preview.data)}</p>
          {previewFresh
            ? <ul>{describeExtras(preview.data, severity).map((line) => <li key={line}>{line}</li>)}</ul>
            : <p className="field-note">You changed who it is for or how serious it is. Preview again before sending.</p>}
        </div>}

        <div className="print-queue-actions">
          <button type="button" className={severity === "urgent" ? "danger" : undefined} disabled={busy || !ready || !preview || !previewFresh || preview.data.total === 0} onClick={startSend}>
            {severity === "urgent" ? "Review and send urgent alert" : "Send broadcast"}
          </button>
        </div>
        {!preview && ready && <p className="field-note">Preview first, so you know exactly who will get it.</p>}

        <div className="broadcast-save-template">
          <label>Save this as a template<input value={templateName} maxLength={60} onChange={(event) => setTemplateName(event.target.value)} placeholder="Name, for example Late start" disabled={busy} /></label>
          <button type="button" className="ghost" disabled={busy || !templateName.trim() || (!title.trim() && !body.trim())} onClick={() => void saveTemplate()}>Save template</button>
        </div>
        {templates.some((t) => !t.builtin) && <ul className="broadcast-template-list">
          {templates.filter((t) => !t.builtin).map((t) => <li key={t.id}><span>{t.name}</span><button type="button" className="ghost" onClick={() => void deleteTemplate(t.id)}>Delete</button></li>)}
        </ul>}
      </div>
      {sentNote && <p className="admin-form-status broadcast-sent" role="status">{sentNote}</p>}
      {status && <p className="admin-form-status" role="status">{status}</p>}
    </article>

    {confirmUrgent && preview && <ConfirmDeleteModal
      title="Send this urgent alert?"
      confirmWord="URGENT"
      confirmLabel="Send urgent alert now"
      busy={busy}
      description={<>
        <b>{title.trim()}</b> will go to <b>{describePreview(preview.data)}</b> right now, on every channel each person allows, and cannot be recalled.
        A banner shows on their screens until they tap Got it.
      </>}
      onConfirm={() => void send()}
      onCancel={() => setConfirmUrgent(false)}
    />}

    <article className="integration-card broadcast-history">
      <div className="integration-card-head"><h3>Sent so far</h3></div>
      {history.length === 0 && <p className="field-note">Nothing has been sent yet.</p>}
      {history.map((row) => <CollapsibleRecord key={row.id}
        summary={<>{row.title}</>}
        meta={<>{new Date(row.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {row.audience_label ?? ""}</>}
        chips={<><span className={`broadcast-chip broadcast-chip-${row.severity}`}>{row.severity}</span> <span className="broadcast-chip">{row.reached} of {row.recipient_count} reached{row.severity === "urgent" ? `, ${row.acked} tapped Got it` : ""}</span></>}>
        <BroadcastReport id={row.id} onChanged={() => void loadHistory()} />
      </CollapsibleRecord>)}
    </article>
  </section>;
}

function BroadcastReport({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("admin_broadcast_report", { p_id: id });
    if (error) { setMessage(error.message); return; }
    setReport(data as Report);
  }, [id]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
  useEffect(() => { void load(); }, [load]);

  async function end() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.rpc("admin_end_broadcast", { p_id: id });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("The banner is off for everyone who had not tapped Got it.");
    await load(); onChanged();
  }

  if (!report) return <p className="field-note">{message || "Loading the report…"}</p>;
  const count = (channel: "push" | "email" | "sms", statusName: string) => report.channels[channel]?.[statusName] ?? 0;
  const unreached = report.people.filter((p) => !p.reached);

  return <div className="broadcast-report">
    <p className="broadcast-report-headline">
      Reached {report.reached} of {report.recipients}. Not reached: {report.not_reached}.
      {report.severity === "urgent" ? ` Tapped Got it: ${report.acked}.` : ""}
    </p>
    <table className="broadcast-channels">
      <thead><tr><th>Channel</th><th>Sent</th><th>Failed</th><th>Skipped</th><th>Waiting</th></tr></thead>
      <tbody>
        {(["push", "email", "sms"] as const).map((channel) => <tr key={channel}>
          <th scope="row">{channel === "push" ? "Push" : channel === "email" ? "Email" : "Text"}</th>
          <td>{count(channel, "sent")}</td><td>{count(channel, "failed")}</td><td>{count(channel, "skipped")}</td>
          <td>{count(channel, "queued") + count(channel, "sending")}</td>
        </tr>)}
      </tbody>
    </table>
    <p className="field-note">“Sent” means the provider accepted it. Anyone who opened it in the app counts as reached, whatever else happened.</p>
    {unreached.length > 0 && <>
      <p className="card-kicker">Not reached</p>
      <ul className="broadcast-unreached">
        {unreached.map((p) => <li key={p.user_id}>
          <b>{p.name}</b>
          <span className="field-note">{[
            p.push ? `push: ${p.push}${p.push_reason ? ` (${why(p.push_reason)})` : ""}` : "",
            p.email_status ? `email: ${p.email_status}${p.email_reason ? ` (${why(p.email_reason)})` : ""}` : "",
            p.sms ? `text: ${p.sms}${p.sms_reason ? ` (${why(p.sms_reason)})` : ""}` : "",
          ].filter(Boolean).join(" · ") || "nothing was sent"}</span>
        </li>)}
      </ul>
    </>}
    {report.active && <div className="print-queue-actions">
      <button type="button" className="ghost" disabled={busy} onClick={() => void end()}>End the alert (turn the banner off)</button>
    </div>}
    {message && <p className="admin-form-status" role="status">{message}</p>}
  </div>;
}
