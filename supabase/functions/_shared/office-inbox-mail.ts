import { FilterXSS, getDefaultWhiteList } from "npm:xss@1.0.15";
import { base64UrlDecode, base64UrlEncode, type GmailHeader, type GmailMessage, type GmailPart } from "./gmail.ts";

/**
 * Turning Gmail messages into office-inbox rows, and replies into MIME. No network here.
 */

export type InboxCategory = "general" | "concern" | "reimbursement" | "dues" | "enrollment" | "absence" | "other";

export type AttachmentPart = {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
  inlineData: string | null;
  contentId: string | null;
  isInline: boolean;
};

export type ParsedMessage = {
  gmail_message_id: string;
  gmail_thread_id: string;
  direction: "inbound" | "outbound";
  from_address: string | null;
  from_name: string | null;
  reply_to: string | null;
  to: string[];
  cc: string[];
  subject: string;
  sent_at: string;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  body_text: string;
  body_html: string | null;
  snippet: string;
  category: InboxCategory;
  attachments: AttachmentPart[];
};

// --- headers -----------------------------------------------------------------------------------
export function header(headers: GmailHeader[] | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = (headers ?? []).find((h) => h.name.toLowerCase() === wanted);
  return found ? found.value : null;
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  try {
    return new TextDecoder(label === "us-ascii" ? "utf-8" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** RFC 2047 encoded words (=?UTF-8?B?...?= and =?ISO-8859-1?Q?...?=). Plain text passes through. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          const binary = atob(text);
          return decodeBytes(Uint8Array.from(binary, (c) => c.charCodeAt(0)), charset);
        }
        const bytes: number[] = [];
        const q = text.replace(/_/g, " ");
        for (let i = 0; i < q.length; i++) {
          if (q[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(q.slice(i + 1, i + 3))) { bytes.push(parseInt(q.slice(i + 1, i + 3), 16)); i += 2; }
          else bytes.push(q.charCodeAt(i));
        }
        return decodeBytes(new Uint8Array(bytes), charset);
      } catch {
        return text;
      }
    });
}

export type Address = { address: string; name: string | null };

/** "Ann Smith" <ann@x.org>, bob@y.org  ->  two addresses. Commas inside quotes or <> are kept. */
export function parseAddressList(value: string | null): Address[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle++;
    else if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  const out: Address[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angled = part.match(/^(.*)<([^<>]+)>\s*$/);
    const address = (angled ? angled[2] : part).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) continue;
    const name = angled ? decodeEncodedWords(angled[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"')).trim() : "";
    out.push({ address, name: name || null });
  }
  return out;
}

// --- bodies ------------------------------------------------------------------------------------
function charsetOf(part: GmailPart): string | null {
  const contentType = header(part.headers, "Content-Type") ?? "";
  const match = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return match ? match[1] : null;
}

function isAttachment(part: GmailPart): boolean {
  const disposition = (header(part.headers, "Content-Disposition") ?? "").toLowerCase();
  return Boolean(part.filename) || disposition.startsWith("attachment") || Boolean(part.body?.attachmentId && !part.mimeType?.startsWith("text/"));
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void) {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

/** A readable plain-text version of an HTML body, for search, the snippet and HTML-only mail. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const htmlFilter = new FilterXSS({
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

/**
 * Email HTML, made safe to store: no scripts, styles, event handlers, forms or frames, and
 * only http(s), mailto, cid and data-image links. The portal sanitises again before showing it,
 * in a sandbox that blocks remote images until an administrator asks for them.
 */
export function sanitizeEmailHtml(html: string): string {
  return htmlFilter.process(html);
}

// --- categories --------------------------------------------------------------------------------
/** A first guess, from words in the subject and body. Administrators can change it. */
export function guessCategory(subject: string, text: string): InboxCategory {
  const s = `${subject}\n${text.slice(0, 4000)}`.toLowerCase();
  if (/\b(complaint|complain|concern|concerned|grievance)\b/.test(s)) return "concern";
  if (/\b(reimburse|reimbursement|reimbursed|receipts?)\b/.test(s)) return "reimbursement";
  if (/\b(dues|invoice|tuition|refund|payment)\b/.test(s)) return "dues";
  if (/\b(absent|absence|substitute|sub for|can'?t make it|cannot make it|sick)\b/.test(s)) return "absence";
  if (/\b(enrol|enroll|enrolment|enrollment|register|registration|waitlist|wait list)\b/.test(s)) return "enrollment";
  return "general";
}

// --- one Gmail message -------------------------------------------------------------------------
export function parseGmailMessage(message: GmailMessage, mailboxAddress: string): ParsedMessage {
  const headers = message.payload?.headers ?? [];
  const from = parseAddressList(header(headers, "From"))[0] ?? null;
  const replyTo = parseAddressList(header(headers, "Reply-To"))[0] ?? null;
  const subject = decodeEncodedWords(header(headers, "Subject") ?? "").replace(/\s+/g, " ").trim();
  const mailbox = mailboxAddress.trim().toLowerCase();
  const labels = message.labelIds ?? [];
  const outbound = from?.address === mailbox || (labels.includes("SENT") && !labels.includes("INBOX"));

  let text: string | null = null;
  let html: string | null = null;
  const attachments: AttachmentPart[] = [];
  walk(message.payload, (part) => {
    if (part.parts?.length) return;
    if (isAttachment(part)) {
      const contentId = (header(part.headers, "Content-ID") ?? "").replace(/^<|>$/g, "") || null;
      const disposition = (header(part.headers, "Content-Disposition") ?? "").toLowerCase();
      attachments.push({
        index: attachments.length,
        filename: decodeEncodedWords(part.filename || "attachment").replace(/[\r\n]/g, " ").slice(0, 255),
        mimeType: (part.mimeType || "application/octet-stream").toLowerCase(),
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? null,
        inlineData: part.body?.attachmentId ? null : part.body?.data ?? null,
        contentId,
        isInline: disposition.startsWith("inline") && Boolean(contentId),
      });
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    const decoded = decodeBytes(base64UrlDecode(data), charsetOf(part));
    if (part.mimeType === "text/plain" && text === null) text = decoded;
    else if (part.mimeType === "text/html" && html === null) html = decoded;
  });

  const bodyText = (text ?? (html ? htmlToText(html) : "")).replace(/\r\n/g, "\n");
  const internal = Number(message.internalDate);
  const dateHeader = header(headers, "Date");
  const sentAt = Number.isFinite(internal) && internal > 0
    ? new Date(internal)
    : dateHeader && !Number.isNaN(Date.parse(dateHeader)) ? new Date(dateHeader) : new Date();
  const snippet = (message.snippet ? decodeHtmlEntities(message.snippet) : bodyText).replace(/\s+/g, " ").trim().slice(0, 200);

  return {
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    direction: outbound ? "outbound" : "inbound",
    from_address: from?.address ?? null,
    from_name: from?.name ?? null,
    reply_to: replyTo && replyTo.address !== from?.address ? replyTo.address : null,
    to: parseAddressList(header(headers, "To")).map((a) => a.address),
    cc: parseAddressList(header(headers, "Cc")).map((a) => a.address),
    subject,
    sent_at: sentAt.toISOString(),
    rfc_message_id: header(headers, "Message-ID") ?? header(headers, "Message-Id"),
    in_reply_to: header(headers, "In-Reply-To"),
    references: header(headers, "References"),
    body_text: bodyText,
    body_html: html ? sanitizeEmailHtml(html) : null,
    snippet,
    category: outbound ? "general" : guessCategory(subject, bodyText),
    attachments,
  };
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
}

/** Which Gmail messages the inbox takes in: the inbox and sent mail, never spam, trash, drafts or chats. */
export function wantedLabels(labelIds: string[] | undefined): boolean {
  const labels = labelIds ?? [];
  if (labels.some((l) => l === "SPAM" || l === "TRASH" || l === "DRAFT" || l === "CHAT")) return false;
  return labels.includes("INBOX") || labels.includes("SENT");
}

// --- replies -----------------------------------------------------------------------------------
/** No line breaks in a header value: a reply can never add a header of its own. */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ").trim();
}

/** Non-ASCII header text as an RFC 2047 encoded word. */
export function encodeHeaderText(value: string): string {
  const safe = headerSafe(value);
  // deno-lint-ignore no-control-regex
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${base64Std(new TextEncoder().encode(safe))}?=`;
}

function formatAddress(address: string, name: string | null): string {
  const cleanAddress = headerSafe(address);
  if (!name) return cleanAddress;
  const display = encodeHeaderText(name);
  return display.startsWith("=?") ? `${display} <${cleanAddress}>` : `"${display.replace(/["\\]/g, "")}" <${cleanAddress}>`;
}

export function replySubject(subject: string): string {
  const clean = headerSafe(subject) || "(no subject)";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** The References chain for a reply: the parent's References plus the parent itself, at most 20 ids. */
export function referencesFor(parentReferences: string | null, parentMessageId: string | null): string | null {
  const ids = `${parentReferences ?? ""} ${parentMessageId ?? ""}`.match(/<[^<>\s]+>/g) ?? [];
  const unique: string[] = [];
  for (const id of ids) if (!unique.includes(id)) unique.push(id);
  return unique.length ? unique.slice(-20).join(" ") : null;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Plain text to simple HTML: paragraphs and line breaks, nothing else. */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}

function base64Std(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64Lines(text: string): string {
  const encoded = base64Std(new TextEncoder().encode(text));
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export type ReplyInput = {
  fromAddress: string;
  fromName: string | null;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  bodyText: string;
  messageId?: string;
  boundary?: string;
};

/** A reply as a raw RFC 5322 message (base64url, as Gmail's send endpoint wants it). */
export function buildReplyMime(input: ReplyInput): { raw: string; subject: string; html: string; messageId: string } {
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(input.to)) throw new Error("There is no address to reply to.");
  const subject = replySubject(input.subject);
  const domain = input.fromAddress.split("@")[1] ?? "localhost";
  const messageId = input.messageId ?? `<${crypto.randomUUID()}@${headerSafe(domain)}>`;
  const boundary = input.boundary ?? `vv-${crypto.randomUUID()}`;
  const html = textToHtml(input.bodyText);
  const references = referencesFor(input.references, input.inReplyTo);
  const lines = [
    `From: ${formatAddress(input.fromAddress, input.fromName)}`,
    `To: ${headerSafe(input.to)}`,
    `Subject: ${encodeHeaderText(subject)}`,
    `Message-ID: ${headerSafe(messageId)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${headerSafe(input.inReplyTo)}`] : []),
    ...(references ? [`References: ${headerSafe(references)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.bodyText.replace(/\r?\n/g, "\r\n")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(`<!doctype html><html><body>${html}</body></html>`),
    `--${boundary}--`,
    "",
  ];
  return { raw: base64UrlEncode(new TextEncoder().encode(lines.join("\r\n"))), subject, html, messageId };
}
