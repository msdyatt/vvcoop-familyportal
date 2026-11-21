"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, getSignedFileUrl } from "../../../lib/storage";
import { coopWallTime } from "../../../lib/coop-time";
import { MONTHS, daysBetween, longDate, rollForward, rollReason } from "../../../lib/compliance-dates";

type Status = "not_started" | "in_progress" | "filed" | "not_needed";
type Deadline = {
  id: string; rule_key: string | null; occurrence_key: string | null; title: string; details: string | null; period_label: string | null;
  nominal_due_on: string; due_on: string; source_url: string | null; status: Status; filed_on: string | null;
  confirmation_number: string | null; record_id: string | null; status_note: string | null; retired_at: string | null;
};
type Rule = {
  key: string; title: string; description: string; applies_to: string; date_rule: string; roll_forward: boolean;
  source_label: string; source_url: string | null; optional: boolean; default_on: boolean; needs_check: boolean;
  needs: string; is_on: boolean; next_due_on: string | null;
};
type Settings = {
  fiscal_year_end_month: number; state: string; has_employees: boolean; pays_contractors: boolean; gross_receipts_size: string;
  rule_switches: Record<string, boolean>; board_meeting_month: number; board_meeting_day: number; handbook_month: number; handbook_day: number;
};

const COLUMNS = "id,rule_key,occurrence_key,title,details,period_label,nominal_due_on,due_on,source_url,status,filed_on,confirmation_number,record_id,status_note,retired_at";
const STATUS_LABEL: Record<Status, string> = { not_started: "Not started", in_progress: "In progress", filed: "Filed", not_needed: "Not needed this year" };
const SIZE_LABEL: Record<string, string> = {
  up_to_50k: "Normally $50,000 or less (Form 990-N)",
  under_200k: "Under $200,000, assets under $500,000 (Form 990-EZ)",
  "200k_or_more": "$200,000 or more, or larger assets (Form 990)",
};
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

function StatusChip({ status }: { status: Status }) {
  return <span className={`deadline-status deadline-status-${status}`}><span className="deadline-status-dot" aria-hidden="true" />{STATUS_LABEL[status]}</span>;
}

function whenLabel(due: string, today: string): string {
  const days = daysBetween(today, due);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days > 0) return `In ${days} days`;
  return `${-days} day${days === -1 ? "" : "s"} overdue`;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keeps the filed copy in the records vault: a new record, the upload, then the registered file. */
async function storeInVault(deadline: Deadline, file: File, filedOn: string, confirmation: string): Promise<string> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error("Not connected.");
  const ext = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : file.type === "image/jpeg" ? "jpg" : null;
  if (!ext) throw new Error("Only a PDF or a photo (JPG, PNG, WebP) can be kept in the vault.");
  const category = deadline.rule_key?.startsWith("irs_") || deadline.rule_key?.startsWith("tx_") ? "tax" : "nonprofit";
  const { data: recordId, error } = await supabase.rpc("admin_create_record", {
    p_title: `${deadline.title}: filed copy`.slice(0, 160), p_category: category, p_issuer: null, p_reference: confirmation || null,
    p_effective_on: filedOn, p_expires_on: null, p_amount_cents: null, p_notes: "Added from Admin, Compliance.", p_tags: ["compliance"],
    p_sensitive: null, p_retain_until: null,
  });
  if (error || !recordId) throw new Error(error?.message ?? "The vault record could not be made.");
  const fileId = crypto.randomUUID();
  const path = `records/${recordId}/${fileId}.${ext}`;
  const upload = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) throw new Error(upload.error.message);
  const { error: addError } = await supabase.rpc("admin_add_record_file", { p_record: recordId, p_file_id: fileId, p_path: path, p_file_name: file.name, p_sha256: await sha256Hex(file), p_change_note: null });
  if (addError) throw new Error(addError.message);
  return recordId as string;
}

export default function ComplianceTab() {
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [vaultTitles, setVaultTitles] = useState<Map<string, string>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<"upcoming" | "history" | "rules" | "settings">("upcoming");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const today = coopWallTime(new Date()).date;

  const load = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [{ data: rows, error }, { data: ruleRows }, { data: settingsRow }] = await Promise.all([
      supabase.from("compliance_deadlines").select(COLUMNS).order("due_on"),
      supabase.rpc("admin_compliance_rules"),
      supabase.from("compliance_settings").select("fiscal_year_end_month,state,has_employees,pays_contractors,gross_receipts_size,rule_switches,board_meeting_month,board_meeting_day,handbook_month,handbook_day").maybeSingle(),
    ]);
    if (error) { setMessage(error.message); return; }
    const list = (rows ?? []) as Deadline[];
    setDeadlines(list); setRules((ruleRows ?? []) as Rule[]); setSettings((settingsRow ?? null) as Settings | null);
    const ids = [...new Set(list.map((row) => row.record_id).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: records } = await supabase.from("org_records").select("id,title").in("id", ids);
      setVaultTitles(new Map(((records ?? []) as { id: string; title: string }[]).map((row) => [row.id, row.title])));
    }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on open
  useEffect(() => { void load(); }, [load]);

  const open = useMemo(() => deadlines.filter((row) => !row.retired_at && (row.status === "not_started" || row.status === "in_progress")), [deadlines]);
  const overdue = open.filter((row) => row.due_on < today);
  const upcoming = open.filter((row) => row.due_on >= today);
  const doneUpcoming = deadlines.filter((row) => !row.retired_at && row.due_on >= today && (row.status === "filed" || row.status === "not_needed"));
  const history = useMemo(() => {
    const past = deadlines.filter((row) => row.due_on < today || row.status === "filed" || row.status === "not_needed" || row.retired_at);
    const byYear = new Map<string, Deadline[]>();
    for (const row of past) { const year = row.due_on.slice(0, 4); byYear.set(year, [...(byYear.get(year) ?? []), row]); }
    return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [deadlines, today]);

  async function regenerate() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("admin_regenerate_compliance_deadlines");
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    const r = data as { added: number; changed: number; removed: number; retired: number };
    setMessage(r.added + r.changed + r.removed + r.retired === 0 ? "Everything was already up to date." : `Updated: ${r.added} added, ${r.changed} changed, ${r.removed} removed, ${r.retired} kept as history.`);
    await load();
  }

  const row = (deadline: Deadline) => <li key={deadline.id} className="deadline-row">
    <button type="button" className="deadline-summary" aria-expanded={openId === deadline.id} onClick={() => setOpenId(openId === deadline.id ? null : deadline.id)}>
      <span className="deadline-date"><b>{longDate(deadline.due_on).replace(/, \d{4}$/, "")}</b><small>{deadline.due_on.slice(0, 4)}</small></span>
      <span className="deadline-title"><b>{deadline.title}</b><small>{deadline.retired_at ? "No longer applies (settings changed)" : deadline.status === "filed" ? `Filed ${longDate(deadline.filed_on!)}` : whenLabel(deadline.due_on, today)}{deadline.rule_key ? "" : " · added by hand"}</small></span>
      <StatusChip status={deadline.status} />
    </button>
    {openId === deadline.id && <DeadlineDetail deadline={deadline} today={today} vaultTitle={deadline.record_id ? vaultTitles.get(deadline.record_id) ?? "a records-vault document" : null}
      busy={busy} setBusy={setBusy} setMessage={setMessage} reload={load} />}
  </li>;

  return <div className="deadlines">
    <div className="deadlines-head">
      <div>
        <h2>Compliance</h2>
        <p className="dues-note">Filing deadlines and renewals for the co-op. Only administrators see them, here and on the calendar. This is a reminder list, not legal or tax advice: items marked &ldquo;check&rdquo; need confirming with the agency named, and a tax professional should confirm what the co-op files.</p>
      </div>
      <button type="button" className="ghost" disabled={busy} onClick={regenerate}>Refresh deadlines</button>
    </div>
    <p className="deadlines-why">If the co-op does not file its IRS annual return (990-N, 990-EZ or 990) for three years in a row, it loses its tax-exempt status automatically. That is why these reminders matter.</p>
    <div className="deadlines-views" role="tablist" aria-label="Compliance views">
      {(["upcoming", "history", "rules", "settings"] as const).map((key) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
        {key === "upcoming" ? "Upcoming" : key === "history" ? "History" : key === "rules" ? "Rules" : "Settings"}
      </button>)}
    </div>
    {message && <p className="dues-note" role="status">{message}</p>}

    {view === "upcoming" && <>
      {overdue.length > 0 && <section aria-labelledby="deadlines-overdue"><h3 id="deadlines-overdue" className="deadlines-overdue-heading">Past due</h3><ul className="deadline-list">{overdue.map(row)}</ul></section>}
      <section aria-labelledby="deadlines-upcoming"><h3 id="deadlines-upcoming">Next 18 months</h3>
        <ul className="deadline-list">{upcoming.map(row)}</ul>
        {!upcoming.length && <p className="portal-empty">Nothing open in the next 18 months.</p>}
      </section>
      {doneUpcoming.length > 0 && <section aria-labelledby="deadlines-done"><h3 id="deadlines-done">Already done</h3><ul className="deadline-list">{doneUpcoming.map(row)}</ul></section>}
      <CustomDeadlineForm busy={busy} setBusy={setBusy} setMessage={setMessage} reload={load} />
    </>}

    {view === "history" && <>
      {history.map(([year, rows]) => <section key={year} aria-labelledby={`deadlines-${year}`}>
        <h3 id={`deadlines-${year}`}>{year}</h3>
        <ul className="deadline-list">{rows.map(row)}</ul>
      </section>)}
      {!history.length && <p className="portal-empty">No past deadlines yet. Filed and past ones collect here by year.</p>}
    </>}

    {view === "rules" && <RulesList rules={rules} />}
    {view === "settings" && settings && <SettingsForm settings={settings} rules={rules} busy={busy} setBusy={setBusy} setMessage={setMessage} reload={load} />}
  </div>;
}

function DeadlineDetail({ deadline, today, vaultTitle, busy, setBusy, setMessage, reload }: {
  deadline: Deadline; today: string; vaultTitle: string | null; busy: boolean;
  setBusy: (b: boolean) => void; setMessage: (m: string) => void; reload: () => Promise<void>;
}) {
  const [status, setStatus] = useState<Status>(deadline.status);
  const moved = deadline.due_on !== deadline.nominal_due_on;

  async function openVaultFile() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !deadline.record_id) return;
    const { data: files } = await supabase.from("org_record_files").select("id").eq("record_id", deadline.record_id).order("version_no", { ascending: false }).limit(1);
    const fileId = (files ?? [])[0]?.id as string | undefined;
    if (!fileId) { setMessage("That vault record has no file yet."); return; }
    const { data: path, error } = await supabase.rpc("admin_open_record_file", { p_file: fileId, p_purpose: "view" });
    if (error || !path) { setMessage(error?.message ?? "The file could not be opened."); return; }
    const url = await getSignedFileUrl(supabase, path as string, 120);
    if (url) window.open(url, "_blank", "noopener,noreferrer"); else setMessage("The file could not be opened.");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const filedOn = String(form.get("filed_on") ?? "");
    const confirmation = String(form.get("confirmation") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    const file = form.get("file");
    setBusy(true); setMessage("");
    try {
      let recordId: string | null = null;
      if (status === "filed" && file instanceof File && file.size > 0) recordId = await storeInVault(deadline, file, filedOn, confirmation);
      const { error } = await supabase.rpc("admin_set_compliance_status", {
        p_deadline: deadline.id, p_status: status, p_filed_on: status === "filed" ? filedOn || null : null,
        p_confirmation: confirmation || null, p_record: recordId, p_note: note || null,
      });
      if (error) throw new Error(error.message);
      setMessage(status === "filed" ? `Marked filed${recordId ? ", with the copy kept in the records vault" : ""}.` : `Marked ${STATUS_LABEL[status].toLowerCase()}.`);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${deadline.title}"? It comes off the calendar too.`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.rpc("admin_delete_custom_deadline", { p_id: deadline.id });
    setBusy(false);
    setMessage(error ? error.message : "Deleted.");
    if (!error) await reload();
  }

  return <div className="deadline-detail">
    <p><b>Due {longDate(deadline.due_on)}</b>{deadline.period_label ? ` · ${deadline.period_label}` : ""}</p>
    {moved && <p className="dues-note">The rule gives {longDate(deadline.nominal_due_on)}, which is {rollReason(deadline.nominal_due_on) ?? "not a business day"}, so it moves to the next business day.</p>}
    {deadline.details && <p className="deadline-details">{deadline.details}</p>}
    {deadline.source_url && <p><a href={deadline.source_url} target="_blank" rel="noopener noreferrer">Official source</a></p>}
    {deadline.status === "filed" && <p className="dues-note">Filed {longDate(deadline.filed_on!)}{deadline.confirmation_number ? ` · confirmation ${deadline.confirmation_number}` : ""}.</p>}
    {vaultTitle && <p className="dues-note">Kept in the records vault: {vaultTitle}. <button type="button" className="link" onClick={openVaultFile}>Open the file</button> (opening it is logged)</p>}
    {deadline.status_note && <p className="dues-note">Note: {deadline.status_note}</p>}
    {!deadline.retired_at && <form className="compliance-form deadline-form" onSubmit={save}>
      <label>Status<select value={status} onChange={(e) => setStatus(e.target.value as Status)} disabled={busy}>
        {(Object.keys(STATUS_LABEL) as Status[]).map((key) => <option key={key} value={key}>{STATUS_LABEL[key]}</option>)}
      </select></label>
      {status === "filed" && <>
        <label>Date filed<input name="filed_on" type="date" required max={today} defaultValue={deadline.filed_on ?? today} /></label>
        <label>Confirmation number<input name="confirmation" maxLength={120} defaultValue={deadline.confirmation_number ?? ""} placeholder="From the IRS or state receipt" /></label>
        <label>Copy of what was filed (optional)<input name="file" type="file" accept={ACCEPT} /></label>
      </>}
      <label>{status === "not_needed" ? "Why it is not needed this year" : "Note (optional)"}<input name="note" maxLength={1000} required={status === "not_needed"} defaultValue={deadline.status_note ?? ""} /></label>
      <div className="dues-actions">
        <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {!deadline.rule_key && deadline.status !== "filed" && <button type="button" className="ghost danger" disabled={busy} onClick={remove}>Delete</button>}
      </div>
    </form>}
  </div>;
}

function CustomDeadlineForm({ busy, setBusy, setMessage, reload }: { busy: boolean; setBusy: (b: boolean) => void; setMessage: (m: string) => void; reload: () => Promise<void> }) {
  const [date, setDate] = useState("");
  const [roll, setRoll] = useState(true);
  const reason = date ? rollReason(date) : null;

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true); setMessage("");
    const { error } = await supabase.rpc("admin_save_custom_deadline", {
      p_id: null, p_title: String(form.get("title") ?? ""), p_due_on: date || null, p_details: String(form.get("details") ?? "") || null,
      p_source_url: String(form.get("source") ?? "") || null, p_roll_forward: roll,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Added. It is on the calendar for administrators."); formEl.reset(); setDate("");
    await reload();
  }

  return <details className="deadline-add">
    <summary>Add a deadline by hand</summary>
    <form className="compliance-form" onSubmit={add}>
      <p className="dues-note">For anything the rules do not cover: a grant report, a notice from the Texas Secretary of State, a city permit.</p>
      <label>What is due<input name="title" required maxLength={200} /></label>
      <label>Due date<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="dues-agree"><input type="checkbox" checked={roll} onChange={(e) => setRoll(e.target.checked)} /> <span>Move it off weekends and federal holidays</span></label>
      {date && roll && reason && <p className="dues-note">That is {reason}, so it will be due {longDate(rollForward(date))}.</p>}
      <label>Details (optional)<input name="details" maxLength={2000} /></label>
      <label>Link to the official page (optional)<input name="source" type="url" placeholder="https://" /></label>
      <button disabled={busy}>Add deadline</button>
    </form>
  </details>;
}

function RulesList({ rules }: { rules: Rule[] }) {
  return <div className="deadline-rules">
    <p className="dues-note">The rules the calendar follows. Items marked &ldquo;check&rdquo; may not apply to the co-op; confirm them with the agency named before relying on them.</p>
    <ul>
      {rules.map((rule) => <li key={rule.key} className={rule.is_on ? "" : "off"}>
        <div className="deadline-rule-head">
          <b>{rule.title}</b>
          <span className="deadline-rule-tags">
            {rule.needs_check && <span className="deadline-tag check">Check</span>}
            <span className="deadline-tag">{rule.is_on ? "On" : rule.needs === "notice" ? "Add by hand" : "Off"}</span>
          </span>
        </div>
        <p>{rule.description}</p>
        <dl>
          <dt>Applies to</dt><dd>{rule.applies_to}</dd>
          <dt>Date</dt><dd>{rule.date_rule}{rule.roll_forward ? ". Moves to the next business day if it falls on a weekend or legal holiday." : "."}</dd>
          {rule.next_due_on && <><dt>Next</dt><dd>{longDate(rule.next_due_on)}</dd></>}
          <dt>Source</dt><dd>{rule.source_url ? <a href={rule.source_url} target="_blank" rel="noopener noreferrer">{rule.source_label}</a> : rule.source_label}</dd>
        </dl>
      </li>)}
    </ul>
  </div>;
}

function SettingsForm({ settings, rules, busy, setBusy, setMessage, reload }: {
  settings: Settings; rules: Rule[]; busy: boolean; setBusy: (b: boolean) => void; setMessage: (m: string) => void; reload: () => Promise<void>;
}) {
  const [s, setS] = useState<Settings>(settings);
  const optional = rules.filter((rule) => rule.optional);
  const ruleOn = (rule: Rule) => s.rule_switches[rule.key] ?? rule.default_on;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setMessage("");
    const { data, error } = await supabase.rpc("admin_update_compliance_settings", {
      p_fiscal_year_end_month: s.fiscal_year_end_month, p_has_employees: s.has_employees, p_pays_contractors: s.pays_contractors,
      p_gross_receipts_size: s.gross_receipts_size, p_rule_switches: s.rule_switches, p_board_meeting_month: s.board_meeting_month,
      p_board_meeting_day: s.board_meeting_day, p_handbook_month: s.handbook_month, p_handbook_day: s.handbook_day,
    });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    const r = data as { added: number; changed: number; removed: number; retired: number };
    setMessage(`Saved. Deadlines updated: ${r.added} added, ${r.changed} changed, ${r.removed} removed${r.retired ? `, ${r.retired} kept as history` : ""}.`);
    await reload();
  }

  const monthSelect = (value: number, onChange: (n: number) => void, label: string) =>
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={busy}>{MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}</select>;

  return <form className="compliance-form deadline-settings" onSubmit={save}>
    <fieldset>
      <legend>About the co-op</legend>
      <label>Fiscal year ends{monthSelect(s.fiscal_year_end_month, (n) => setS({ ...s, fiscal_year_end_month: n }), "Fiscal year end month")}</label>
      <p className="dues-note">On the last day of that month. Most co-ops use 31 December; check the IRS determination letter or the last return filed.</p>
      <label>State<select value={s.state} disabled><option value="TX">Texas</option></select></label>
      <label className="dues-agree"><input type="checkbox" checked={s.has_employees} onChange={(e) => setS({ ...s, has_employees: e.target.checked })} /> <span>The co-op has employees (on payroll)</span></label>
      <label className="dues-agree"><input type="checkbox" checked={s.pays_contractors} onChange={(e) => setS({ ...s, pays_contractors: e.target.checked })} /> <span>The co-op pays independent contractors (for example, paid teachers who are not employees)</span></label>
      <label>Usual size of gross receipts<select value={s.gross_receipts_size} onChange={(e) => setS({ ...s, gross_receipts_size: e.target.value })} disabled={busy}>
        {Object.entries(SIZE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <p className="dues-note">This only names the return on the calendar. The year-end tax summary works it out from the books.</p>
    </fieldset>
    <fieldset>
      <legend>Board and school-year dates</legend>
      <label>Annual board meeting
        <span className="deadline-day">{monthSelect(s.board_meeting_month, (n) => setS({ ...s, board_meeting_month: n }), "Board meeting month")}
          <input type="number" aria-label="Board meeting day" min={1} max={31} value={s.board_meeting_day} onChange={(e) => setS({ ...s, board_meeting_day: Number(e.target.value) })} /></span></label>
      <label>Handbook and waiver refresh
        <span className="deadline-day">{monthSelect(s.handbook_month, (n) => setS({ ...s, handbook_month: n }), "Handbook refresh month")}
          <input type="number" aria-label="Handbook refresh day" min={1} max={31} value={s.handbook_day} onChange={(e) => setS({ ...s, handbook_day: Number(e.target.value) })} /></span></label>
    </fieldset>
    <fieldset>
      <legend>Optional items</legend>
      {optional.map((rule) => <label key={rule.key} className="dues-agree"><input type="checkbox" checked={ruleOn(rule)}
        onChange={(e) => setS({ ...s, rule_switches: { ...s.rule_switches, [rule.key]: e.target.checked } })} /> <span>{rule.title}</span></label>)}
    </fieldset>
    <button disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
  </form>;
}
