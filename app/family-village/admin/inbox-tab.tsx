"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CoopLogo from "../../coop-logo";
import { FilterXSS, getDefaultWhiteList } from "xss";
import { functionErrorMessage, getSupabaseBrowserClient } from "../../../lib/supabase";
import { formatCoopDateTime } from "../../../lib/coop-time";
import { useBackLayer } from "../../../lib/use-back-layer";
import {
  buildTimeline, CATEGORIES, categoryLabel, describeEvent, emailDocument, type FamilyContext, formatBytes, formatMoneyCents,
  hasRemoteImages, type InboxAttachment, type InboxCategory, type InboxMessage, type InboxStatus, listTime, senderLabel,
  splitQuoted, STATUSES, statusLabel, type ThreadDetail, type ThreadRow,
} from "../../../lib/office-inbox";
import DetailModal from "../detail-modal";

/**
 * The shared office inbox (issue #112): the co-op's office email, for administrators.
 *
 * Desktop: filters and threads | the conversation with the reply box | the family's context.
 * Phone: one column. The list opens a thread; "Family" opens the context as a sheet.
 *
 * Everything is read and changed through the office_inbox_* database functions (administrators
 * only, logged). Replies go through the office-inbox-send function, which sends from the office
 * address in the same Gmail thread.
 */

type Filter = "active" | "new" | "open" | "waiting" | "done" | "mine" | "unassigned" | "unread" | "all";
const FILTERS: { value: Filter; label: string; countKey?: string }[] = [
  { value: "active", label: "Not done" },
  { value: "new", label: "New", countKey: "new" },
  { value: "open", label: "Open", countKey: "open" },
  { value: "waiting", label: "Waiting on family", countKey: "waiting" },
  { value: "mine", label: "Assigned to me", countKey: "mine" },
  { value: "unassigned", label: "Unassigned", countKey: "unassigned" },
  { value: "unread", label: "Unread", countKey: "unread" },
  { value: "done", label: "Done" },
  { value: "all", label: "Everything" },
];

type Canned = { id: string; title: string; body: string };
type Admin = { id: string; name: string };
type Connection = { status: string; mailbox_address: string | null; last_sync_at: string | null } | null;

// Sanitised again here before display (the server already did it on import).
const emailFilter = new FilterXSS({
  whiteList: {
    ...getDefaultWhiteList(),
    table: ["width", "border", "align", "valign", "cellpadding", "cellspacing"],
    td: ["width", "rowspan", "colspan", "align", "valign"],
    th: ["width", "rowspan", "colspan", "align", "valign"],
    img: ["src", "alt", "title", "width", "height"],
    a: ["href", "title"],
  },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style", "head", "title", "iframe", "object", "embed", "form", "svg", "math"],
  allowCommentTag: false,
});

function filterArgs(filter: Filter, query: string, category: string) {
  const args: Record<string, unknown> = { p_limit: 100 };
  if (["new", "open", "waiting", "done", "active"].includes(filter)) args.p_status = filter;
  if (filter === "mine") { args.p_assignee = "me"; args.p_status = "active"; }
  if (filter === "unassigned") { args.p_assignee = "none"; args.p_status = "active"; }
  if (filter === "unread") args.p_unread_only = true;
  if (query.trim()) args.p_query = query.trim();
  if (category) args.p_category = category;
  return args;
}

function StatusChip({ status }: { status: InboxStatus }) {
  return <span className={`inbox-status inbox-status-${status}`}><span className="inbox-status-dot" aria-hidden />{statusLabel(status)}</span>;
}

export default function InboxTab() {
  const [filter, setFilter] = useState<Filter>("active");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [context, setContext] = useState<FamilyContext | null>(null);
  const [canned, setCanned] = useState<Canned[]>([]);
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [connection, setConnection] = useState<Connection>(null);
  const [status, setStatus] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [manageCanned, setManageCanned] = useState(false);

  // Phone: a thread open over the list is a step Back undoes; so is the family sheet.
  useBackLayer(selectedId !== null, () => setSelectedId(null));
  useBackLayer(sheetOpen, () => setSheetOpen(false));

  const loadList = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [list, totals] = await Promise.all([
      supabase.rpc("office_inbox_threads", filterArgs(filter, appliedQuery, category)),
      supabase.rpc("office_inbox_counts"),
    ]);
    if (list.error) { setStatus(`Could not load the inbox: ${list.error.message}`); setThreads([]); return; }
    setThreads((list.data ?? []) as ThreadRow[]);
    if (!totals.error) setCounts((totals.data ?? {}) as Record<string, number>);
  }, [filter, appliedQuery, category]);

  const loadThread = useCallback(async (id: string) => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [one, ctx] = await Promise.all([
      supabase.rpc("office_inbox_thread", { p_thread: id }),
      supabase.rpc("office_inbox_family_context", { p_thread: id }),
    ]);
    if (one.error) { setStatus(`Could not open the conversation: ${one.error.message}`); return; }
    setDetail(one.data as ThreadDetail);
    setContext(ctx.error ? null : ctx.data as FamilyContext);
    // Opening marks it read; reflect that in the list without a reload.
    setThreads((rows) => rows?.map((row) => (row.id === id ? { ...row, unread: false } : row)) ?? rows);
  }, []);

  const loadSide = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const [c, a, s] = await Promise.all([
      supabase.from("inbox_canned_replies").select("id,title,body").eq("archived", false).order("title"),
      supabase.rpc("office_inbox_admins"),
      supabase.rpc("office_inbox_status"),
    ]);
    if (!c.error) setCanned((c.data ?? []) as Canned[]);
    if (!a.error) setAdmins((a.data ?? []) as Admin[]);
    if (!s.error) setConnection(s.data as Connection);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch when the filters change
  useEffect(() => { loadList(); }, [loadList]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time fetch of the side data
  useEffect(() => { loadSide(); }, [loadSide]);
  useEffect(() => {
    if (!selectedId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the previous thread while the next one loads
    setDetail(null); setContext(null);
    loadThread(selectedId);
  }, [selectedId, loadThread]);

  // New mail arrives every minute or so; refresh the list while the page is visible.
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") loadList(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadList]);

  async function act(fn: string, args: Record<string, unknown>, done?: string) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !selectedId) return false;
    const { error } = await supabase.rpc(fn, args);
    if (error) { setStatus(error.message); return false; }
    if (done) setStatus(done);
    await Promise.all([loadThread(selectedId), loadList()]);
    return true;
  }

  function search(event: FormEvent) {
    event.preventDefault();
    setAppliedQuery(query);
  }

  const selectedRow = threads?.find((t) => t.id === selectedId) ?? null;
  const notConnected = connection && connection.status !== "connected";

  return <section className={`inbox${selectedId ? " inbox-has-thread" : ""}`}>
    <p className="admin-form-status inbox-status-line" role="status">{status}</p>
    {notConnected && <p className="inbox-banner">
      {connection.status === "attention"
        ? "The office inbox needs reconnecting, so new mail is not arriving. Go to Integrations, Office inbox."
        : "The office inbox is not connected. Connect it under Integrations, Office inbox."}
    </p>}
    <div className="inbox-grid">
      {/* --- left: filters and threads ------------------------------------------------ */}
      <div className="inbox-list-col">
        <form className="inbox-search" onSubmit={search} role="search">
          <label className="sr-only" htmlFor="inbox-search">Search the office inbox</label>
          <input id="inbox-search" type="search" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setAppliedQuery(""); }}
            placeholder="Search mail, names, addresses" />
          <button type="submit" className="ghost">Search</button>
        </form>
        <div className="inbox-filters">
          <label className="sr-only" htmlFor="inbox-filter">Show</label>
          <select id="inbox-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}{f.countKey && counts[f.countKey] ? ` (${counts[f.countKey]})` : ""}</option>)}
          </select>
          <label className="sr-only" htmlFor="inbox-category">Category</label>
          <select id="inbox-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        {threads === null ? <p className="inbox-muted">Loading…</p>
          : threads.length === 0 ? <EmptyList filtered={filter !== "active" || Boolean(appliedQuery) || Boolean(category)} />
          : <ul className="inbox-threads" aria-label="Conversations">
              {threads.map((t) => <li key={t.id}>
                <button type="button" className={`inbox-thread${t.id === selectedId ? " selected" : ""}${t.unread ? " unread" : ""}`}
                  aria-current={t.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(t.id)}>
                  <span className="inbox-thread-top">
                    {t.unread && <span className="inbox-unread-dot"><span className="sr-only">Unread. </span></span>}
                    <span className="inbox-thread-from">{t.counterpart_name || t.counterpart_email || "Unknown sender"}</span>
                    <span className="inbox-thread-time">{listTime(t.last_message_at)}</span>
                  </span>
                  <span className="inbox-thread-subject">{t.subject || "(no subject)"}</span>
                  <span className="inbox-thread-snippet">{t.snippet}</span>
                  <span className="inbox-thread-meta">
                    <StatusChip status={t.status} />
                    {t.category !== "general" && <span className={`inbox-category inbox-category-${t.category}`}>{categoryLabel(t.category)}</span>}
                    {t.has_attachments && <span className="inbox-meta-text">Attachment</span>}
                    {t.assignee_name && <span className="inbox-meta-text">{t.assignee_name}</span>}
                  </span>
                </button>
              </li>)}
            </ul>}
        <div className="inbox-list-foot">
          <button type="button" className="ghost" onClick={() => setManageCanned(true)}>Canned replies</button>
          {connection?.last_sync_at && <span className="inbox-muted">Last checked {listTime(connection.last_sync_at)}</span>}
        </div>
      </div>

      {/* --- middle: the conversation ---------------------------------------------------- */}
      <div className="inbox-thread-col">
        {!selectedId ? <div className="inbox-placeholder"><p>Choose a conversation.</p></div>
          : !detail ? <p className="inbox-muted">Opening…</p>
          : <ThreadView key={detail.thread.id} detail={detail} admins={admins} canned={canned}
              onBack={() => setSelectedId(null)} onOpenFamily={() => setSheetOpen(true)}
              onStatus={(s) => act("office_inbox_set_status", { p_thread: detail.thread.id, p_status: s }, s === "done" ? "Marked done." : `Status set to ${statusLabel(s)}.`)}
              onAssign={(id) => act("office_inbox_assign", { p_thread: detail.thread.id, p_assignee: id }, id ? "Assigned." : "Assignment removed.")}
              onCategory={(c) => act("office_inbox_set_category", { p_thread: detail.thread.id, p_category: c }, `Category set to ${categoryLabel(c)}.`)}
              onNote={(body) => act("office_inbox_add_note", { p_thread: detail.thread.id, p_body: body }, "Note added. Only administrators see it.")}
              onMarkUnread={async () => {
                const supabase = getSupabaseBrowserClient();
                if (!supabase) return;
                await supabase.rpc("office_inbox_mark_unread", { p_thread: detail.thread.id });
                setSelectedId(null);
                await loadList();
              }}
              onSent={async (message) => { setStatus(message); await Promise.all([loadThread(detail.thread.id), loadList()]); }}
              onError={setStatus} />}
      </div>

      {/* --- right: the family ---------------------------------------------------------------- */}
      <aside className={`inbox-context-col${sheetOpen ? " open" : ""}`} aria-label="Family context">
        {sheetOpen && <button type="button" className="inbox-sheet-scrim" aria-label="Close family details" onClick={() => setSheetOpen(false)} />}
        <div className="inbox-context-sheet">
          <div className="inbox-sheet-head">
            <p className="card-kicker">Family</p>
            <button type="button" className="ghost inbox-sheet-close" onClick={() => setSheetOpen(false)}>Close</button>
          </div>
          {selectedId && context ? <ContextPanel context={context} threadId={selectedId}
            onOpenThread={(id) => { setSheetOpen(false); setSelectedId(id); }}
            onLinked={() => { if (selectedId) { loadThread(selectedId); loadList(); } }} onError={setStatus} />
            : <p className="inbox-muted">{selectedRow ? "Loading…" : "The sender’s household shows here."}</p>}
        </div>
      </aside>
    </div>
    {manageCanned && <CannedRepliesModal canned={canned} onClose={() => setManageCanned(false)} onChanged={loadSide} />}
  </section>;
}

// --- empty state ------------------------------------------------------------------------------------------
function EmptyList({ filtered }: { filtered: boolean }) {
  if (filtered) return <p className="inbox-muted inbox-empty-small">Nothing matches.</p>;
  return <div className="inbox-empty">
    <CoopLogo kind="mark" className="inbox-empty-mark" decorative />
    <p className="inbox-empty-title">The inbox is clear.</p>
    <p className="inbox-muted">Nothing is waiting. Put the kettle on.</p>
  </div>;
}

// --- the conversation ----------------------------------------------------------------------------------------
function ThreadView({ detail, admins, canned, onBack, onOpenFamily, onStatus, onAssign, onCategory, onNote, onMarkUnread, onSent, onError }: {
  detail: ThreadDetail; admins: Admin[]; canned: Canned[];
  onBack: () => void; onOpenFamily: () => void;
  onStatus: (s: InboxStatus) => Promise<boolean>; onAssign: (id: string | null) => Promise<boolean>;
  onCategory: (c: InboxCategory) => Promise<boolean>; onNote: (body: string) => Promise<boolean>;
  onMarkUnread: () => Promise<void>; onSent: (message: string) => Promise<void>; onError: (message: string) => void;
}) {
  const t = detail.thread;
  const timeline = useMemo(() => buildTimeline(detail), [detail]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [detail]);

  return <div className="inbox-thread-view">
    <header className="inbox-thread-head">
      <div className="inbox-thread-head-row">
        <button type="button" className="ghost inbox-back" onClick={onBack}>‹ Inbox</button>
        <button type="button" className="ghost inbox-family-button" onClick={onOpenFamily}>Family</button>
      </div>
      <h2>{t.subject || "(no subject)"}</h2>
      <p className="inbox-thread-with">{senderLabel(t.counterpart_name, t.counterpart_email)}{t.family_name ? ` · ${t.family_name}` : ""}</p>
      <div className="inbox-controls">
        <label><span>Status</span>
          <select value={t.status} onChange={(e) => onStatus(e.target.value as InboxStatus)}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label><span>Assigned to</span>
          <select value={t.assignee_id ?? ""} onChange={(e) => onAssign(e.target.value || null)}>
            <option value="">Nobody</option>
            {admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label><span>Category</span>
          <select value={t.category} onChange={(e) => onCategory(e.target.value as InboxCategory)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <button type="button" className="ghost" onClick={onMarkUnread}>Mark unread</button>
      </div>
      {t.category === "concern" && <p className="inbox-concern-note">A concern. Handle it with the directors and keep notes here rather than in Messages.</p>}
    </header>

    <ol className="inbox-timeline">
      {timeline.map((item, i) => <li key={`${item.kind}-${i}`}>
        {item.kind === "message" ? <MessageCard message={item.message} mailbox={t.mailbox_address} onError={onError} />
          : item.kind === "note" ? <div className="inbox-note">
              <p className="inbox-note-label">Internal note · Only admins see this</p>
              <p className="inbox-note-body">{item.note.body}</p>
              <p className="inbox-note-meta">{item.note.author_name ?? "An administrator"} · {formatCoopDateTime(item.note.created_at)}</p>
            </div>
          : <p className="inbox-event">{describeEvent(item.event)} <span>{formatCoopDateTime(item.event.created_at)}</span></p>}
      </li>)}
    </ol>
    <div ref={endRef} />
    <Composer threadId={t.id} replyTo={t.reply_to} mailbox={t.mailbox_address} canned={canned} onNote={onNote} onSent={onSent} onError={onError} />
  </div>;
}

function MessageCard({ message, mailbox, onError }: { message: InboxMessage; mailbox: string | null; onError: (m: string) => void }) {
  const outbound = message.direction === "outbound";
  const [showQuoted, setShowQuoted] = useState(false);
  const [images, setImages] = useState(false);
  const text = message.body_text ?? "";
  const { fresh, quoted } = splitQuoted(text);
  const html = message.body_html ? emailFilter.process(message.body_html) : null;
  const remote = hasRemoteImages(html);
  const files = message.attachments.filter((a) => !a.is_inline || !html);

  return <article className={`inbox-message${outbound ? " outbound" : ""}`}>
    <header>
      <span className="inbox-message-from">{outbound ? (message.sent_by_name ? `${message.sent_by_name} (office)` : "Office") : senderLabel(message.from_name, message.from_address)}</span>
      <span className="inbox-channel">Email</span>
      <time dateTime={message.sent_at}>{formatCoopDateTime(message.sent_at)}</time>
    </header>
    <p className="inbox-message-to">To {message.to_addresses.join(", ") || mailbox}{message.cc_addresses.length ? ` · Cc ${message.cc_addresses.join(", ")}` : ""}</p>
    {html
      ? <>
          {remote && !images && <p className="inbox-images-note">Images from the internet are hidden.{" "}
            <button type="button" className="linklike" onClick={() => setImages(true)}>Load images</button></p>}
          <EmailFrame html={html} allowImages={images} />
        </>
      : <div className="inbox-message-text">
          <p>{fresh || (quoted ? "" : "(empty message)")}</p>
          {quoted && <>
            <button type="button" className="linklike" onClick={() => setShowQuoted(!showQuoted)}>{showQuoted ? "Hide earlier messages" : "Show earlier messages"}</button>
            {showQuoted && <p className="inbox-quoted">{quoted}</p>}
          </>}
        </div>}
    {files.length > 0 && <ul className="inbox-attachments" aria-label="Attachments">
      {files.map((a) => <li key={a.id}><AttachmentLink attachment={a} onError={onError} /></li>)}
    </ul>}
  </article>;
}

/** The email's own HTML, in a sandbox: no scripts, remote content blocked until asked for. */
function EmailFrame({ html, allowImages }: { html: string; allowImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const doc = useMemo(() => emailDocument(html, allowImages), [html, allowImages]);
  function measure() {
    const body = ref.current?.contentDocument?.body;
    if (body) setHeight(Math.min(Math.max(body.scrollHeight + 8, 60), 4000));
  }
  return <iframe ref={ref} className="inbox-email-frame" title="Email message" srcDoc={doc} style={{ height }}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" onLoad={measure} />;
}

function AttachmentLink({ attachment, onError }: { attachment: InboxAttachment; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function open() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    // A logged, two-minute grant, then a one-minute signed link for this file only.
    const { data, error } = await supabase.rpc("office_inbox_open_attachment", { p_attachment: attachment.id });
    if (error) { setBusy(false); onError(error.message); return; }
    const { data: signed, error: signError } = await supabase.storage.from("office-inbox").createSignedUrl(data.path, 60, { download: attachment.filename });
    setBusy(false);
    if (signError || !signed?.signedUrl) { onError("Could not open the attachment."); return; }
    window.location.assign(signed.signedUrl);
  }
  const size = formatBytes(attachment.size_bytes);
  if (!attachment.stored) return <span className="inbox-attachment missing">{attachment.filename}{size ? ` · ${size}` : ""} · too large to copy, open it in Gmail</span>;
  return <button type="button" className="inbox-attachment" disabled={busy} onClick={open}>
    {busy ? "Opening…" : attachment.filename}{size ? <span> · {size}</span> : null}
  </button>;
}

// --- the reply box --------------------------------------------------------------------------------------------------
function Composer({ threadId, replyTo, mailbox, canned, onNote, onSent, onError }: {
  threadId: string; replyTo: string | null; mailbox: string | null; canned: Canned[];
  onNote: (body: string) => Promise<boolean>; onSent: (m: string) => Promise<void>; onError: (m: string) => void;
}) {
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [body, setBody] = useState("");
  const [next, setNext] = useState<"waiting" | "open" | "done">("waiting");
  const [busy, setBusy] = useState(false);
  // One key per reply being written: a retry or a double click is the same reply.
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());

  function insertCanned(id: string) {
    const item = canned.find((c) => c.id === id);
    if (!item) return;
    setBody((current) => (current.trim() ? `${current.trimEnd()}\n\n${item.body}` : item.body));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    if (mode === "note") {
      if (await onNote(body)) setBody("");
      setBusy(false);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setBusy(false); return; }
    const { data, error } = await supabase.functions.invoke("office-inbox-send", { body: { threadId, body, clientKey, nextStatus: next } });
    setBusy(false);
    if (error || data?.error) { onError(await functionErrorMessage(error, data, "The reply could not be sent.")); return; }
    setBody("");
    setClientKey(crypto.randomUUID());
    await onSent(data?.duplicate ? "That reply was already sent." : next === "done" ? `Reply sent to ${data?.to ?? replyTo}. Marked done.` : `Reply sent to ${data?.to ?? replyTo}.`);
  }

  return <form className={`inbox-composer${mode === "note" ? " note-mode" : ""}`} onSubmit={submit}>
    <div className="inbox-composer-tabs" role="tablist" aria-label="Write">
      <button type="button" role="tab" aria-selected={mode === "reply"} className={mode === "reply" ? "active" : ""} onClick={() => setMode("reply")}>Reply</button>
      <button type="button" role="tab" aria-selected={mode === "note"} className={mode === "note" ? "active" : ""} onClick={() => setMode("note")}>Internal note</button>
    </div>
    {mode === "reply" && canned.length > 0 && <label className="inbox-canned-picker"><span>Canned reply</span>
      <select value="" onChange={(e) => { insertCanned(e.target.value); e.target.value = ""; }}>
        <option value="">Insert…</option>
        {canned.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select>
    </label>}
    <label className="sr-only" htmlFor={`composer-${threadId}`}>{mode === "reply" ? "Reply" : "Internal note"}</label>
    <textarea id={`composer-${threadId}`} value={body} onChange={(e) => setBody(e.target.value)} rows={4} disabled={busy}
      placeholder={mode === "reply" ? "Write a reply…" : "Write a note for the other administrators…"} />
    {mode === "reply"
      ? <p className="inbox-reply-target">{replyTo
          ? <>Reply will be sent by email to <b>{replyTo}</b>{mailbox ? <> from {mailbox}</> : null}.</>
          : "There is no address to reply to."}</p>
      : <p className="inbox-reply-target">Only admins see this. It is never sent to the family.</p>}
    <div className="row-actions">
      {mode === "reply" && <label className="inbox-next-status"><span>Then</span>
        <select value={next} onChange={(e) => setNext(e.target.value as typeof next)}>
          <option value="waiting">wait on family</option>
          <option value="open">keep open</option>
          <option value="done">mark done</option>
        </select>
      </label>}
      <button type="submit" disabled={busy || !body.trim() || (mode === "reply" && !replyTo)}>
        {busy ? (mode === "reply" ? "Sending…" : "Saving…") : mode === "reply" ? "Send reply" : "Add note"}
      </button>
    </div>
  </form>;
}

// --- the family context ------------------------------------------------------------------------------------------------
function ContextPanel({ context, threadId, onOpenThread, onLinked, onError }: {
  context: FamilyContext; threadId: string; onOpenThread: (id: string) => void; onLinked: () => void; onError: (m: string) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [families, setFamilies] = useState<{ id: string; display_name: string }[]>([]);
  const [choice, setChoice] = useState("");

  async function startLink() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { data, error } = await supabase.from("families").select("id,display_name").order("display_name");
    if (error) { onError(error.message); return; }
    setFamilies(data ?? []);
    setLinking(true);
  }

  async function link(familyId: string | null) {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("office_inbox_link_family", { p_thread: threadId, p_family: familyId });
    if (error) { onError(error.message); return; }
    setLinking(false);
    onLinked();
  }

  return <div className="inbox-context">
    <div className="inbox-context-block">
      <p className="inbox-context-label">Sender</p>
      <p>{context.sender.name ?? context.sender.email}</p>
      {context.sender.name && <p className="inbox-muted">{context.sender.email}</p>}
      <p className="inbox-muted">{context.sender.portal_account ? "Has a portal account." : "No portal account with this address."}</p>
    </div>

    {!context.matched ? <div className="inbox-context-block">
        <p>Not matched to a household.</p>
        {!linking ? <button type="button" className="ghost" onClick={startLink}>Link to a household</button>
          : <div className="inbox-link-family">
              <label className="sr-only" htmlFor="inbox-link-family">Household</label>
              <select id="inbox-link-family" value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose a household…</option>
                {families.map((f) => <option key={f.id} value={f.id}>{f.display_name}</option>)}
              </select>
              <div className="row-actions">
                <button type="button" disabled={!choice} onClick={() => link(choice)}>Link</button>
                <button type="button" className="ghost" onClick={() => setLinking(false)}>Cancel</button>
              </div>
            </div>}
      </div>
      : <>
        <div className="inbox-context-block">
          <p className="inbox-context-label">Household</p>
          <p className="inbox-context-family">{context.family?.name}</p>
          {context.linked_by_hand && <p className="inbox-muted">Linked by hand. <button type="button" className="linklike" onClick={() => link(null)}>Remove link</button></p>}
          {context.adults.length > 0 && <ul className="inbox-context-list">
            {context.adults.map((a) => <li key={a.email}>{a.name}{a.relationship ? ` (${a.relationship})` : ""}{a.status !== "active" ? ` · ${a.status}` : ""}</li>)}
          </ul>}
        </div>
        <div className="inbox-context-block">
          <p className="inbox-context-label">Children</p>
          {context.children.length ? <ul className="inbox-context-list">
            {context.children.map((c, i) => <li key={i}>{c.first_name}{c.last_name ? ` ${c.last_name}` : ""}{c.grade ? ` · grade ${c.grade}` : ""}{c.active ? "" : " · not active"}</li>)}
          </ul> : <p className="inbox-muted">None listed.</p>}
        </div>
        <div className="inbox-context-block">
          <p className="inbox-context-label">Forms this year</p>
          {context.forms.length ? <ul className="inbox-context-list">
            {context.forms.map((f, i) => <li key={i}>{f.title} · <span className={f.status === "complete" || f.status === "waived" ? "inbox-ok" : "inbox-todo"}>{f.status === "complete" ? "done" : f.status}</span></li>)}
          </ul> : <p className="inbox-muted">No forms required.</p>}
        </div>
        <div className="inbox-context-block">
          <p className="inbox-context-label">Dues this year</p>
          {context.dues.length ? <ul className="inbox-context-list">
            {context.dues.map((d, i) => <li key={i}>{d.title} · {formatMoneyCents(d.amount_paid_cents)} of {formatMoneyCents(d.amount_due_cents)} paid{d.status === "paid" ? "" : ` · ${d.status.replace("_", " ")}`}</li>)}
          </ul> : <p className="inbox-muted">No dues recorded.</p>}
        </div>
      </>}

    <div className="inbox-context-block">
      <p className="inbox-context-label">Earlier conversations</p>
      {context.earlier_threads.length ? <ul className="inbox-context-list">
        {context.earlier_threads.map((o) => <li key={o.id}>
          <button type="button" className="linklike" onClick={() => onOpenThread(o.id)}>{o.subject || "(no subject)"}</button>
          <span className="inbox-muted"> · {statusLabel(o.status)}{o.last_message_at ? ` · ${listTime(o.last_message_at)}` : ""}</span>
        </li>)}
      </ul> : <p className="inbox-muted">None.</p>}
    </div>
  </div>;
}

// --- canned replies -----------------------------------------------------------------------------------------------------
function CannedRepliesModal({ canned, onClose, onChanged }: { canned: Canned[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<Canned | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function edit(item: Canned | null) {
    setEditing(item ?? { id: "", title: "", body: "" });
    setTitle(item?.title ?? "");
    setBody(item?.body ?? "");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !editing) return;
    setBusy(true);
    const { error } = await supabase.rpc("office_inbox_save_canned", { p_id: editing.id || null, p_title: title, p_body: body });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Saved.");
    setEditing(null);
    await onChanged();
  }

  async function archive(item: Canned) {
    if (!confirm(`Remove the canned reply "${item.title}"?`)) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const { error } = await supabase.rpc("office_inbox_archive_canned", { p_id: item.id });
    if (error) { setMessage(error.message); return; }
    setMessage("Removed.");
    await onChanged();
  }

  return <DetailModal title="Canned replies" onClose={onClose}>
    <div className="portal-form inbox-canned">
      {editing ? <form onSubmit={save}>
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required /></label>
          <label>Text<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={5000} required /></label>
          <div className="row-actions">
            <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
        : <>
          {canned.length ? <ul className="inbox-canned-list">
            {canned.map((c) => <li key={c.id}>
              <div><b>{c.title}</b><p className="inbox-muted">{c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body}</p></div>
              <div className="row-actions">
                <button type="button" className="ghost" onClick={() => edit(c)}>Edit</button>
                <button type="button" className="ghost danger" onClick={() => archive(c)}>Remove</button>
              </div>
            </li>)}
          </ul> : <p className="portal-empty">No canned replies yet. Add the answers you give most often.</p>}
          <div className="row-actions"><button type="button" onClick={() => edit(null)}>Add a canned reply</button></div>
        </>}
      <p className="admin-form-status" role="status">{message}</p>
    </div>
  </DetailModal>;
}
