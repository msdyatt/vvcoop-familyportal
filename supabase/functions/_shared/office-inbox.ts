import {
  base64UrlDecode, type FetchLike, GmailApiError, GmailClient, GoogleAuthError, refreshAccessToken, type SleepFn,
} from "./gmail.ts";
import { type AttachmentPart, buildReplyMime, header, parseGmailMessage, wantedLabels } from "./office-inbox-mail.ts";

/**
 * The office inbox's two jobs, written against small interfaces so the tests can run them with a
 * fake database, fake storage and a fake network:
 *   runSync   bring new office mail into the portal (Gmail history API, or a first import)
 *   sendReply send one administrator's reply through Gmail, in the family's thread
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

export type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }>;
export type Upload = (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: { message: string } | null }>;

export const REFRESH_TOKEN_SECRET = "OFFICE_INBOX_REFRESH_TOKEN";
/** Attachments larger than this stay in Gmail; the portal lists them and says so. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** How many new messages one run takes in. The rest wait for the next minute. */
export const MESSAGES_PER_RUN = 40;

export type OAuthClient = { clientId: string; clientSecret: string };

export type SyncDeps = {
  rpc: Rpc;
  upload: Upload;
  fetch: FetchLike;
  oauth: OAuthClient;
  sleep?: SleepFn;
  perRun?: number;
};

export type SyncResult = {
  ran: boolean;
  imported: number;
  skipped: number;
  remaining: number;
  error: string | null;
  attention: boolean;
};

async function call(rpc: Rpc, fn: string, args?: Record<string, unknown>) {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/** A fresh access token for the office mailbox, from the refresh token in Vault. */
export async function officeAccessToken(rpc: Rpc, fetchFn: FetchLike, oauth: OAuthClient): Promise<string> {
  const refreshToken = await call(rpc, "read_vault_secret", { secret_name: REFRESH_TOKEN_SECRET }) as string | null;
  if (!refreshToken) throw new GoogleAuthError("The office mailbox authorisation is missing. Reconnect the office inbox.");
  return await refreshAccessToken(fetchFn, oauth, refreshToken);
}

type Candidate = { id: string; labelIds?: string[] };

/** Every message added since `startHistoryId`, oldest first, and the history id to resume from. */
async function collectHistory(gmail: GmailClient, startHistoryId: string): Promise<{ ids: string[]; nextHistoryId: string | null }> {
  const seen = new Set<string>();
  const ids: string[] = [];
  let pageToken: string | undefined;
  let nextHistoryId: string | null = null;
  for (let page = 0; page < 20; page++) {
    const answer = await gmail.history(startHistoryId, pageToken);
    nextHistoryId = answer.historyId ?? nextHistoryId;
    for (const entry of answer.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        const candidate: Candidate = added.message;
        if (!wantedLabels(candidate.labelIds) || seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        ids.push(candidate.id);
      }
    }
    if (!answer.nextPageToken) return { ids, nextHistoryId };
    pageToken = answer.nextPageToken;
  }
  // Too much at once: take what was listed and do not move the bookmark past what was not.
  return { ids, nextHistoryId: null };
}

/** The first import: recent inbox mail, oldest first. */
async function collectRecent(gmail: GmailClient, days: number): Promise<string[]> {
  if (days <= 0) return [];
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const answer = await gmail.listMessages(`in:inbox newer_than:${days}d`, pageToken);
    for (const m of answer.messages ?? []) ids.push(m.id);
    if (!answer.nextPageToken) break;
    pageToken = answer.nextPageToken;
  }
  return ids.reverse();
}

async function storeAttachment(gmail: GmailClient, upload: Upload, messageId: string, part: AttachmentPart) {
  const base = { filename: part.filename, mime_type: part.mimeType, size_bytes: part.size, content_id: part.contentId, is_inline: part.isInline };
  if (part.size > MAX_ATTACHMENT_BYTES) return { ...base, storage_path: null };
  let data = part.inlineData;
  if (!data && part.attachmentId) data = (await gmail.getAttachment(messageId, part.attachmentId)).data ?? null;
  if (!data) return { ...base, storage_path: null };
  const bytes = base64UrlDecode(data);
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ...base, storage_path: null, size_bytes: bytes.length };
  const path = `messages/${messageId}/${part.index}`;
  const { error } = await upload(path, bytes, part.mimeType);
  if (error) throw new Error(`Could not store an attachment: ${error.message}`);
  return { ...base, size_bytes: bytes.length, storage_path: path };
}

/**
 * One poll. Takes the lease (or does nothing if another run holds it or the mailbox is not
 * connected), reads what is new, imports it, labels it in Gmail, and records the outcome.
 */
export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { ran: false, imported: 0, skipped: 0, remaining: 0, error: null, attention: false };
  const claim = await call(deps.rpc, "office_inbox_claim_sync") as
    { mailbox_address: string; gmail_label_id: string | null; history_id: string | null; backfill_days: number } | null;
  if (!claim) return result;
  result.ran = true;

  let nextHistoryId: string | null = null;
  let resetHistory = false;
  try {
    const accessToken = await officeAccessToken(deps.rpc, deps.fetch, deps.oauth);
    const gmail = new GmailClient(deps.fetch, accessToken, deps.sleep);
    const labelId = claim.gmail_label_id ?? await gmail.ensureLabel();

    let ids: string[];
    if (claim.history_id) {
      try {
        const history = await collectHistory(gmail, claim.history_id);
        ids = history.ids;
        nextHistoryId = history.nextHistoryId;
      } catch (error) {
        // The bookmark is too old for Gmail to answer from (it keeps about a week). Start again
        // from the last week of inbox mail; anything already imported is skipped.
        if (!(error instanceof GmailApiError) || error.status !== 404) throw error;
        const profile = await gmail.profile();
        ids = await collectRecent(gmail, Math.min(claim.backfill_days || 7, 7));
        nextHistoryId = profile.historyId;
        resetHistory = true;
      }
    } else {
      // Read the bookmark before listing, so nothing that arrives during the import is missed.
      const profile = await gmail.profile();
      ids = await collectRecent(gmail, claim.backfill_days);
      nextHistoryId = profile.historyId;
    }

    const known = new Set(ids.length ? await call(deps.rpc, "office_inbox_known_messages", { p_ids: ids }) as string[] : []);
    const fresh = ids.filter((id) => !known.has(id));
    const batch = fresh.slice(0, deps.perRun ?? MESSAGES_PER_RUN);
    result.remaining = fresh.length - batch.length;

    const toLabel: string[] = [];
    for (const id of batch) {
      let message;
      try {
        message = await gmail.getMessage(id);
      } catch (error) {
        // Gone since it was listed (deleted in Gmail by someone): nothing to import.
        if (error instanceof GmailApiError && error.status === 404) { result.skipped++; continue; }
        throw error;
      }
      if (!wantedLabels(message.labelIds)) { result.skipped++; continue; }
      const parsed = parseGmailMessage(message, claim.mailbox_address);
      const attachments = [];
      for (const part of parsed.attachments) attachments.push(await storeAttachment(gmail, deps.upload, message.id, part));
      const answer = await call(deps.rpc, "office_inbox_import_message", { p: { ...parsed, attachments } }) as { created?: boolean; skipped?: string };
      if (answer?.created) { result.imported++; toLabel.push(id); }
      else { result.skipped++; if (answer?.skipped === "known") toLabel.push(id); }
    }

    try {
      await gmail.addLabels(toLabel, labelId);
    } catch (error) {
      // The messages are in the portal; a missing label only affects how Gmail shows them.
      result.error = `Imported, but the Gmail label could not be added: ${error instanceof Error ? error.message : String(error)}`;
    }

    const finished = result.remaining === 0;
    await call(deps.rpc, "office_inbox_finish_sync", {
      p_history_id: finished ? nextHistoryId : null,
      p_imported: result.imported,
      p_error: result.error,
      p_attention: false,
      p_reset_history: !finished && resetHistory,
    });
    return result;
  } catch (error) {
    result.attention = error instanceof GoogleAuthError;
    result.error = error instanceof Error ? error.message : String(error);
    await call(deps.rpc, "office_inbox_finish_sync", {
      p_history_id: null, p_imported: result.imported, p_error: result.error, p_attention: result.attention, p_reset_history: false,
    });
    return result;
  }
}

// --- replies ----------------------------------------------------------------------------------------
export class ReplyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyRefused";
  }
}

export type SendDeps = { rpc: Rpc; fetch: FetchLike; oauth: OAuthClient; sleep?: SleepFn };
export type SendInput = { userId: string; threadId: string; body: string; clientKey: string; nextStatus: "open" | "waiting" | "done" };
export type SendResult = { ok: true; duplicate: boolean; to?: string } | { ok: false; error: string };

/**
 * Sends one reply. The database checks the sender and the limits and records the attempt first,
 * so a reply is never sent without a row saying who sent it; the outcome is then recorded either way.
 */
export async function sendReply(deps: SendDeps, input: SendInput): Promise<SendResult> {
  const { data: begin, error } = await deps.rpc("office_inbox_begin_send", {
    p_user: input.userId, p_thread: input.threadId, p_body: input.body, p_client_key: input.clientKey, p_next_status: input.nextStatus,
  });
  if (error) throw new ReplyRefused(error.message);
  if (begin?.duplicate) {
    return begin.status === "failed" ? { ok: false, error: "That reply did not send. Write it again to retry." } : { ok: true, duplicate: true };
  }

  const finish = (ok: boolean, fields: { gmailId?: string | null; rfcId?: string | null; subject?: string; html?: string; error?: string }) =>
    call(deps.rpc, "office_inbox_finish_send", {
      p_send: begin.send_id, p_ok: ok, p_gmail_message_id: fields.gmailId ?? null, p_rfc_message_id: fields.rfcId ?? null,
      p_subject: fields.subject ?? null, p_body_html: fields.html ?? null, p_error: fields.error ?? null,
    });

  let mime;
  try {
    mime = buildReplyMime({
      fromAddress: begin.from_address, fromName: begin.from_name, to: begin.to, subject: begin.subject ?? "",
      inReplyTo: begin.in_reply_to ?? null, references: begin.references ?? null, bodyText: input.body,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await finish(false, { error: message });
    return { ok: false, error: message };
  }

  let sent;
  let gmail: GmailClient;
  try {
    const accessToken = await officeAccessToken(deps.rpc, deps.fetch, deps.oauth);
    gmail = new GmailClient(deps.fetch, accessToken, deps.sleep);
    sent = await gmail.send(mime.raw, begin.gmail_thread_id ?? null);
  } catch (e) {
    const message = e instanceof GoogleAuthError
      ? "Google refused the office mailbox authorisation. Reconnect the office inbox in Admin, Integrations."
      : `Gmail did not send the reply: ${e instanceof Error ? e.message : String(e)}`;
    await finish(false, { error: message });
    return { ok: false, error: message };
  }

  // Gmail may set its own Message-ID; read back the one it used so the next reply threads to it.
  let rfcId: string | null = mime.messageId;
  try {
    const meta = await gmail.getMessageId(sent.id);
    rfcId = header(meta.payload?.headers, "Message-ID") ?? header(meta.payload?.headers, "Message-Id") ?? rfcId;
  } catch { /* keep ours */ }

  await finish(true, { gmailId: sent.id, rfcId, subject: mime.subject, html: mime.html });
  return { ok: true, duplicate: false, to: begin.to };
}
