/**
 * Shared shapes and small pure helpers for the office inbox screens (issue #112).
 * No imports, so the Deno tests can load it directly (lib/office-inbox.test.ts).
 */

export type InboxStatus = "new" | "open" | "waiting" | "done";
export type InboxCategory = "general" | "concern" | "reimbursement" | "dues" | "enrollment" | "absence" | "other";

export const STATUSES: { value: InboxStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "open", label: "Open" },
  { value: "waiting", label: "Waiting on family" },
  { value: "done", label: "Done" },
];

export const CATEGORIES: { value: InboxCategory; label: string }[] = [
  { value: "general", label: "General" },
  { value: "concern", label: "Concern" },
  { value: "reimbursement", label: "Reimbursement" },
  { value: "dues", label: "Dues" },
  { value: "enrollment", label: "Enrollment" },
  { value: "absence", label: "Absence" },
  { value: "other", label: "Other" },
];

export function statusLabel(status: string): string {
  return STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function categoryLabel(category: string): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? category;
}

export type ThreadRow = {
  id: string;
  subject: string;
  counterpart_email: string | null;
  counterpart_name: string | null;
  family_id: string | null;
  family_name: string | null;
  status: InboxStatus;
  category: InboxCategory;
  assignee_id: string | null;
  assignee_name: string | null;
  snippet: string | null;
  message_count: number;
  has_attachments: boolean;
  last_message_at: string | null;
  unread: boolean;
};

export type InboxAttachment = { id: string; filename: string; mime_type: string | null; size_bytes: number | null; is_inline: boolean; stored: boolean };
export type InboxMessage = {
  id: string;
  direction: "inbound" | "outbound";
  from_address: string | null;
  from_name: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string | null;
  sent_at: string;
  body_text: string | null;
  body_html: string | null;
  sent_by_name: string | null;
  attachments: InboxAttachment[];
};
export type InboxNote = { id: string; body: string; author_name: string | null; created_at: string };
export type InboxEvent = { kind: string; detail: Record<string, unknown>; actor_name: string | null; created_at: string };
export type ThreadDetail = {
  thread: ThreadRow & { reply_to: string | null; mailbox_address: string | null; family_linked_by_hand: boolean };
  messages: InboxMessage[];
  notes: InboxNote[];
  events: InboxEvent[];
};

export type FamilyContext = {
  matched: boolean;
  linked_by_hand: boolean;
  sender: { email: string | null; name: string | null; portal_account: boolean };
  family: { id: string; name: string } | null;
  adults: { name: string; email: string; relationship: string | null; status: string }[];
  children: { first_name: string; last_name: string | null; grade: string | null; active: boolean }[];
  forms: { title: string; status: string }[];
  dues: { title: string; amount_due_cents: number; amount_paid_cents: number; status: string }[];
  earlier_threads: { id: string; subject: string; status: InboxStatus; category: InboxCategory; last_message_at: string | null }[];
};

/** Messages, notes and history in time order, for the conversation column. */
export type TimelineItem =
  | { kind: "message"; at: string; message: InboxMessage }
  | { kind: "note"; at: string; note: InboxNote }
  | { kind: "event"; at: string; event: InboxEvent };

export function buildTimeline(detail: Pick<ThreadDetail, "messages" | "notes" | "events">): TimelineItem[] {
  const items: TimelineItem[] = [
    ...detail.messages.map((message) => ({ kind: "message" as const, at: message.sent_at, message })),
    ...detail.notes.map((note) => ({ kind: "note" as const, at: note.created_at, note })),
    ...detail.events.map((event) => ({ kind: "event" as const, at: event.created_at, event })),
  ];
  const rank = { message: 0, note: 1, event: 2 };
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || rank[a.kind] - rank[b.kind]);
}

/** One line for a history entry: "Sam set the status to Done." */
export function describeEvent(event: InboxEvent): string {
  const who = event.actor_name ?? "The portal";
  const d = event.detail ?? {};
  switch (event.kind) {
    case "status":
      if (d.reason === "new_mail") return `New mail moved this back to ${statusLabel(String(d.to))}.`;
      if (d.reason === "reply_sent") return `${who} replied and set the status to ${statusLabel(String(d.to))}.`;
      return `${who} set the status to ${statusLabel(String(d.to))}.`;
    case "assigned":
      return d.to ? `${who} assigned this to ${d.to_name ?? "an administrator"}.` : `${who} removed the assignment.`;
    case "category":
      return `${who} changed the category to ${categoryLabel(String(d.to))}.`;
    case "family_linked":
      return d.to ? `${who} linked this to a household.` : `${who} removed the household link.`;
    case "reply_failed":
      return `A reply by ${who} did not send.`;
    default:
      return `${who}: ${event.kind.replace(/_/g, " ")}.`;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMoneyCents(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** Whether a message's HTML asks for anything from the network (shown only after "Load images"). */
export function hasRemoteImages(html: string | null | undefined): boolean {
  return Boolean(html && /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(html));
}

/**
 * The document an email's HTML is shown in, inside an iframe with sandbox="allow-same-origin
 * allow-popups allow-popups-to-escape-sandbox" (no scripts ever run). The HTML has already been
 * sanitised twice. The content policy blocks everything from the network unless the administrator
 * chose to load images for this message, and even then allows only images. Links open in a new tab.
 * The email is shown as paper (light) in both themes.
 */
export function emailDocument(sanitizedHtml: string, allowRemoteImages: boolean): string {
  const imgSrc = allowRemoteImages ? "data: cid: https:" : "data: cid:";
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:`;
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    "<meta name=\"referrer\" content=\"no-referrer\">",
    "<base target=\"_blank\">",
    "<style>html,body{margin:0;background:#fff;color:#1b1b1b;font:15px/1.5 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;overflow-wrap:anywhere}",
    "body{padding:2px}img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #ccc;color:#555}a{color:#0b4f7a}</style>",
    "</head><body>",
    sanitizedHtml,
    "</body></html>",
  ].join("");
}

/** Splits plain text into the new part and the quoted history ("On … wrote:" and "> " lines). */
export function splitQuoted(text: string): { fresh: string; quoted: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    if (/^On .+wrote:\s*$/.test(line) || (/^On .+/.test(line) && /wrote:\s*$/.test(next))) { cut = i; break; }
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) { cut = i; break; }
    if (/^>/.test(line) && lines.slice(i).every((l) => /^>/.test(l) || l.trim() === "")) { cut = i; break; }
  }
  return { fresh: lines.slice(0, cut).join("\n").trimEnd(), quoted: lines.slice(cut).join("\n").trim() };
}

/** "Ann Parent <ann@example.org>" or just the address. */
export function senderLabel(name: string | null | undefined, address: string | null | undefined): string {
  if (name && address) return `${name} <${address}>`;
  return name || address || "Unknown sender";
}

/** "2:14 PM" today, "Tue" this week, "Nov 3" this year, "Nov 3, 2025" before. Co-op time zone. */
export function listTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  const tz = "America/Chicago";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  if (day(at) === day(now)) return at.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  const ageDays = (now.getTime() - at.getTime()) / 86_400_000;
  if (ageDays < 6) return at.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  const sameYear = at.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" }) === now.toLocaleDateString("en-US", { timeZone: tz, year: "numeric" });
  return at.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
