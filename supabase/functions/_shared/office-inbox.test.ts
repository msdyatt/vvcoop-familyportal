/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse, assertMatch, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  base64UrlDecode, base64UrlEncode, buildAuthUrl, exchangeCode, type FetchLike, GMAIL_SCOPE, GmailApiError, GmailClient, type GmailMessage,
  GoogleAuthError, pkceChallenge, refreshAccessToken,
} from "./gmail.ts";
import {
  buildReplyMime, decodeEncodedWords, guessCategory, parseAddressList, parseGmailMessage, referencesFor, sanitizeEmailHtml, wantedLabels,
} from "./office-inbox-mail.ts";
import { ReplyRefused, runSync, sendReply } from "./office-inbox.ts";
import { loadInboxConfig } from "./office-inbox-env.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

// --- a fake Google: no real network, ever ----------------------------------------------------
type Seen = { method: string; url: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
type Reply = { status?: number; body?: unknown } | ((req: Seen) => { status?: number; body?: unknown });

function fakeGoogle(routes: Record<string, Reply | Reply[]>) {
  const requests: Seen[] = [];
  const counters: Record<string, number> = {};
  const fetchFn: FetchLike = (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: any = raw;
    if (headers["content-type"]?.includes("json")) body = JSON.parse(raw || "null");
    if (headers["content-type"]?.includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw));
    const path = `${url.host}${url.pathname}`;
    const seen = { method, url: input, path, query: url.searchParams, headers, body };
    requests.push(seen);
    const key = `${method} ${path}`;
    let route: Reply | Reply[] | undefined = routes[key];
    if (route === undefined) {
      const prefix = Object.keys(routes).find((k) => k.endsWith("*") && key.startsWith(k.slice(0, -1)));
      route = prefix ? routes[prefix] : undefined;
    }
    if (route === undefined) return Promise.resolve(new Response(JSON.stringify({ error: { message: `no fake for ${key}` } }), { status: 404 }));
    if (Array.isArray(route)) {
      const n = counters[key] ?? 0;
      counters[key] = n + 1;
      route = route[Math.min(n, route.length - 1)];
    }
    const answer = typeof route === "function" ? route(seen) : route;
    const status = answer.status ?? 200;
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(answer.body ?? {}), { status, headers: { "Content-Type": "application/json" } }));
  };
  return { fetchFn, requests };
}

const GMAIL = "gmail.googleapis.com/gmail/v1/users/me";
const TOKEN = "POST oauth2.googleapis.com/token";
const noSleep = () => Promise.resolve();
const b64 = (text: string) => base64UrlEncode(new TextEncoder().encode(text));
const decodeRaw = (raw: string) => new TextDecoder().decode(base64UrlDecode(raw));

/** No request in a test ever deletes or trashes mail. */
function assertNothingDeleted(requests: Seen[]) {
  for (const r of requests) {
    assertFalse(r.method === "DELETE", `DELETE ${r.path}`);
    assertFalse(/\/(trash|delete)\b/.test(r.path) || r.path.endsWith("/batchDelete"), `delete-like call ${r.path}`);
    if (r.path.endsWith("/batchModify")) assertEquals(r.body.removeLabelIds, undefined, "labels are only ever added");
  }
}

// --- a fake database ---------------------------------------------------------------------------
function fakeDb(handlers: Record<string, (args: any) => any>) {
  const calls: { fn: string; args: any }[] = [];
  const rpc = (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    const handler = handlers[fn];
    if (!handler) return Promise.resolve({ data: null, error: { message: `no fake for ${fn}` } });
    try {
      const data = handler(args);
      if (data && typeof data === "object" && "__error" in data) return Promise.resolve({ data: null, error: { message: data.__error } });
      return Promise.resolve({ data, error: null });
    } catch (error) {
      return Promise.resolve({ data: null, error: { message: (error as Error).message } });
    }
  };
  return { rpc, calls, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}

function message(id: string, opts: { threadId?: string; from?: string; subject?: string; text?: string; html?: string; labels?: string[]; attachment?: boolean; date?: number } = {}): GmailMessage {
  const parts: any[] = [];
  if (opts.text !== undefined || opts.html !== undefined) {
    const alt: any[] = [];
    if (opts.text !== undefined) alt.push({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }], body: { data: b64(opts.text) } });
    if (opts.html !== undefined) alt.push({ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: b64(opts.html) } });
    parts.push({ mimeType: "multipart/alternative", parts: alt });
  }
  if (opts.attachment) {
    parts.push({
      mimeType: "image/jpeg", filename: "receipt.jpg",
      headers: [{ name: "Content-Disposition", value: 'attachment; filename="receipt.jpg"' }],
      body: { size: 5, attachmentId: `att-${id}` },
    });
  }
  return {
    id, threadId: opts.threadId ?? `t-${id}`, labelIds: opts.labels ?? ["INBOX", "UNREAD"], snippet: "Hello there",
    internalDate: String(opts.date ?? Date.UTC(2026, 10, 18, 15, 0, 0)),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: opts.from ?? '"Ann Parent" <ann@example.org>' },
        { name: "To", value: "office@veritasvillage.org" },
        { name: "Subject", value: opts.subject ?? "Question" },
        { name: "Message-ID", value: `<${id}@mail.example.org>` },
      ],
      parts,
    },
  };
}

// --- OAuth ------------------------------------------------------------------------------------
const oauthConfig = { clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://ref.supabase.co/functions/v1/office-inbox-oauth" };

Deno.test("buildAuthUrl: offline access to the mailbox only, with consent, PKCE, state and the office address pre-filled", async () => {
  const url = new URL(buildAuthUrl(oauthConfig, "state-1", await pkceChallenge("v".repeat(64)), "office@veritasvillage.org"));
  assertEquals(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const p = url.searchParams;
  assertEquals(p.get("scope"), GMAIL_SCOPE);
  assertEquals(p.get("access_type"), "offline");
  assertEquals(p.get("prompt"), "consent");
  assertEquals(p.get("state"), "state-1");
  assertEquals(p.get("code_challenge_method"), "S256");
  assertMatch(p.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assertEquals(p.get("login_hint"), "office@veritasvillage.org");
  assertEquals(p.get("redirect_uri"), oauthConfig.redirectUri);
});

Deno.test("exchangeCode: sends the code and verifier; refuses a grant without mailbox access", async () => {
  const ok = fakeGoogle({ [TOKEN]: { body: { access_token: "at", refresh_token: "rt", scope: GMAIL_SCOPE } } });
  assertEquals(await exchangeCode(ok.fetchFn, oauthConfig, "code-1", "verifier-1"), { accessToken: "at", refreshToken: "rt" });
  assertEquals(ok.requests[0].body.grant_type, "authorization_code");
  assertEquals(ok.requests[0].body.code_verifier, "verifier-1");
  assertEquals(ok.requests[0].body.redirect_uri, oauthConfig.redirectUri);

  const narrow = fakeGoogle({ [TOKEN]: { body: { access_token: "at", refresh_token: "rt", scope: "openid email" } } });
  await assertRejects(() => exchangeCode(narrow.fetchFn, oauthConfig, "c", "v"), GoogleAuthError, "did not grant access");
});

Deno.test("refreshAccessToken: a new access token; a revoked grant needs a reconnect; a Google outage does not", async () => {
  const ok = fakeGoogle({ [TOKEN]: { body: { access_token: "fresh", expires_in: 3599 } } });
  assertEquals(await refreshAccessToken(ok.fetchFn, oauthConfig, "rt"), "fresh");
  assertEquals(ok.requests[0].body, { grant_type: "refresh_token", refresh_token: "rt", client_id: "client-1", client_secret: "secret-1" });

  const revoked = fakeGoogle({ [TOKEN]: { status: 400, body: { error: "invalid_grant" } } });
  await assertRejects(() => refreshAccessToken(revoked.fetchFn, oauthConfig, "rt"), GoogleAuthError, "Reconnect");

  const down = fakeGoogle({ [TOKEN]: { status: 503, body: {} } });
  const error = await refreshAccessToken(down.fetchFn, oauthConfig, "rt").catch((e) => e);
  assert(error instanceof GmailApiError && error.retryable && !(error instanceof GoogleAuthError));
});

// --- the Gmail client ---------------------------------------------------------------------------
Deno.test("GmailClient: bearer token, one retry on a rate limit, and a refused token is an authorisation problem", async () => {
  const { fetchFn, requests } = fakeGoogle({ [`GET ${GMAIL}/profile`]: [{ status: 429 }, { body: { emailAddress: "office@x.org", historyId: "9" } }] });
  const gmail = new GmailClient(fetchFn, "at-1", noSleep);
  assertEquals((await gmail.profile()).historyId, "9");
  assertEquals(requests.length, 2);
  assertEquals(requests[0].headers.authorization, "Bearer at-1");

  const refused = fakeGoogle({ [`GET ${GMAIL}/profile`]: { status: 401, body: { error: { message: "Invalid Credentials" } } } });
  await assertRejects(() => new GmailClient(refused.fetchFn, "bad", noSleep).profile(), GoogleAuthError);

  const broken = fakeGoogle({ [`GET ${GMAIL}/labels`]: { status: 500, body: { error: { message: "Backend Error" } } } });
  const error = await new GmailClient(broken.fetchFn, "at", noSleep).listLabels().catch((e) => e);
  assert(error instanceof GmailApiError);
  assertEquals(error.status, 500);
  assertStringIncludes(error.message, "Backend Error");
  assertEquals(broken.requests.length, 2, "retried once");
});

Deno.test("ensureLabel: reuses the existing label, or makes it once", async () => {
  const existing = fakeGoogle({ [`GET ${GMAIL}/labels`]: { body: { labels: [{ id: "INBOX", name: "INBOX" }, { id: "Label_7", name: "Portal imported" }] } } });
  assertEquals(await new GmailClient(existing.fetchFn, "at").ensureLabel(), "Label_7");
  assertEquals(existing.requests.length, 1);

  const missing = fakeGoogle({
    [`GET ${GMAIL}/labels`]: { body: { labels: [{ id: "INBOX", name: "INBOX" }] } },
    [`POST ${GMAIL}/labels`]: (req) => ({ body: { id: "Label_9", name: req.body.name } }),
  });
  assertEquals(await new GmailClient(missing.fetchFn, "at").ensureLabel(), "Label_9");
  assertEquals(missing.requests[1].body, { name: "Portal imported", labelListVisibility: "labelShow", messageListVisibility: "show" });
});

// --- reading a message ------------------------------------------------------------------------------
Deno.test("parseGmailMessage: headers, encoded subject, Reply-To, both bodies, attachments, category and direction", () => {
  const m = message("m1", { subject: "=?UTF-8?B?UmVpbWJ1cnNlbWVudCDigJMgc3VwcGxpZXM=?=", text: "Receipt attached.\nThanks", html: "<p onclick=\"x()\">Receipt <script>alert(1)</script>attached</p>", attachment: true });
  m.payload!.headers!.push({ name: "Reply-To", value: "Ann P <ann.home@example.org>" }, { name: "Cc", value: '"Smith, Bob" <bob@example.org>, carol@example.org' });
  const parsed = parseGmailMessage(m, "Office@VeritasVillage.org");
  assertEquals(parsed.subject, "Reimbursement – supplies");
  assertEquals(parsed.direction, "inbound");
  assertEquals(parsed.from_address, "ann@example.org");
  assertEquals(parsed.from_name, "Ann Parent");
  assertEquals(parsed.reply_to, "ann.home@example.org");
  assertEquals(parsed.cc, ["bob@example.org", "carol@example.org"]);
  assertEquals(parsed.body_text, "Receipt attached.\nThanks");
  assertFalse(parsed.body_html!.includes("script"));
  assertFalse(parsed.body_html!.includes("onclick"));
  assertEquals(parsed.category, "reimbursement");
  assertEquals(parsed.rfc_message_id, "<m1@mail.example.org>");
  assertEquals(parsed.sent_at, "2026-11-18T15:00:00.000Z");
  assertEquals(parsed.attachments.length, 1);
  assertEquals(parsed.attachments[0].filename, "receipt.jpg");
  assertEquals(parsed.attachments[0].attachmentId, "att-m1");

  const sent = parseGmailMessage(message("m2", { from: "Veritas Village <office@veritasvillage.org>", text: "Reply", labels: ["SENT"] }), "office@veritasvillage.org");
  assertEquals(sent.direction, "outbound");
});

Deno.test("parseGmailMessage: HTML-only mail gets a text version; other character sets are decoded", () => {
  const m = message("m3", { html: "<div>Hello<br>Second line</div><p>New &amp; improved</p>" });
  assertEquals(parseGmailMessage(m, "office@x.org").body_text, "Hello\nSecond line\nNew & improved");

  const latin = message("m4");
  latin.payload!.parts = [{ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }], body: { data: base64UrlEncode(new Uint8Array([0x43, 0x61, 0x66, 0xe9])) } }];
  assertEquals(parseGmailMessage(latin, "office@x.org").body_text, "Café");
});

Deno.test("small helpers: addresses, encoded words, categories, labels, sanitising", () => {
  assertEquals(parseAddressList('"Doe, Jane" <JANE@x.org>, not-an-address, bob@y.org'), [
    { address: "jane@x.org", name: "Doe, Jane" }, { address: "bob@y.org", name: null },
  ]);
  assertEquals(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_hours?="), "Café hours");
  assertEquals(guessCategory("A complaint about pickup", ""), "concern");
  assertEquals(guessCategory("Hello", "I have a concern about class"), "concern");
  assertEquals(guessCategory("Field trip", "Here is my receipt for the bus"), "reimbursement");
  assertEquals(guessCategory("Friday", "We can't make it this week"), "absence");
  assertEquals(guessCategory("Hi", "just saying hello"), "general");
  assert(wantedLabels(["INBOX"]) && wantedLabels(["SENT"]));
  assertFalse(wantedLabels(["INBOX", "SPAM"]) || wantedLabels(["DRAFT"]) || wantedLabels(["TRASH", "INBOX"]) || wantedLabels(["CATEGORY_UPDATES"]));
  const clean = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a><iframe src="https://evil"></iframe><form><input></form><img src=x onerror=alert(1)>');
  assertFalse(/javascript:|iframe|onerror|<form|<input/i.test(clean));
});

// --- writing a reply -------------------------------------------------------------------------------------
Deno.test("buildReplyMime: threads to the parent, keeps the subject, and cannot be used to add headers", () => {
  const mime = buildReplyMime({
    fromAddress: "office@veritasvillage.org", fromName: "Veritas Village", to: "ann@example.org",
    subject: "Field trip\r\nBcc: everyone@example.org", inReplyTo: "<m2@mail.example.org>", references: "<m1@mail.example.org>",
    bodyText: "Thanks, Ann.\n\nSee you Friday.", messageId: "<fixed@veritasvillage.org>", boundary: "b1",
  });
  const raw = decodeRaw(mime.raw);
  const [head, ...rest] = raw.split("\r\n\r\n");
  const lines = head.split("\r\n");
  assert(lines.includes('From: "Veritas Village" <office@veritasvillage.org>'));
  assert(lines.includes("To: ann@example.org"));
  assert(lines.includes("Subject: Re: Field trip Bcc: everyone@example.org"));
  assertFalse(lines.some((l) => l.startsWith("Bcc:")), "no injected header");
  assert(lines.includes("In-Reply-To: <m2@mail.example.org>"));
  assert(lines.includes("References: <m1@mail.example.org> <m2@mail.example.org>"));
  assert(lines.includes("Message-ID: <fixed@veritasvillage.org>"));
  const textPart = rest.join("\r\n\r\n").split("--b1")[1];
  const encoded = textPart.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assertEquals(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))), "Thanks, Ann.\r\n\r\nSee you Friday.");
  assertEquals(mime.html, "<p>Thanks, Ann.</p>\n<p>See you Friday.</p>");

  assertEquals(buildReplyMime({ fromAddress: "o@x.org", fromName: null, to: "a@b.org", subject: "RE: Hi", inReplyTo: null, references: null, bodyText: "x" }).subject, "RE: Hi");
  const accented = decodeRaw(buildReplyMime({ fromAddress: "o@x.org", fromName: "Café", to: "a@b.org", subject: "Été", inReplyTo: null, references: null, bodyText: "x" }).raw);
  assertStringIncludes(accented, "Subject: =?UTF-8?B?");
  let threw = false;
  try { buildReplyMime({ fromAddress: "o@x.org", fromName: null, to: "a@b.org\r\nBcc: x@y.org", subject: "s", inReplyTo: null, references: null, bodyText: "x" }); } catch { threw = true; }
  assert(threw, "a bad To address is refused");
  assertEquals(referencesFor(Array.from({ length: 25 }, (_, i) => `<r${i}@x>`).join(" "), "<p@x>")!.split(" ").length, 20);
});

// --- the sync -----------------------------------------------------------------------------------------------
function syncWorld(opts: { historyId?: string | null; known?: string[]; labelId?: string | null } = {}) {
  const imported: any[] = [];
  const db = fakeDb({
    office_inbox_claim_sync: () => ({ mailbox_address: "office@veritasvillage.org", gmail_label_id: opts.labelId === undefined ? "Label_7" : opts.labelId, history_id: opts.historyId ?? null, backfill_days: 30 }),
    read_vault_secret: ({ secret_name }) => (secret_name === "OFFICE_INBOX_REFRESH_TOKEN" ? "rt-1" : null),
    office_inbox_known_messages: ({ p_ids }) => p_ids.filter((id: string) => (opts.known ?? []).includes(id)),
    office_inbox_import_message: ({ p }) => { imported.push(p); return { created: true, thread_id: "th", message_id: "mm" }; },
    office_inbox_finish_sync: () => null,
  });
  const uploads: { path: string; bytes: Uint8Array; contentType: string }[] = [];
  const upload = (path: string, bytes: Uint8Array, contentType: string) => { uploads.push({ path, bytes, contentType }); return Promise.resolve({ error: null }); };
  return { db, imported, uploads, upload };
}

Deno.test("runSync, first import: recent inbox mail oldest first, attachments stored, labelled in Gmail, bookmark saved", async () => {
  const world = syncWorld();
  const google = fakeGoogle({
    [TOKEN]: { body: { access_token: "at" } },
    [`GET ${GMAIL}/profile`]: { body: { emailAddress: "office@veritasvillage.org", historyId: "500" } },
    [`GET ${GMAIL}/messages`]: { body: { messages: [{ id: "m2", threadId: "t2" }, { id: "m1", threadId: "t1" }] } },
    [`GET ${GMAIL}/messages/m1`]: { body: message("m1", { text: "First", attachment: true }) },
    [`GET ${GMAIL}/messages/m2`]: { body: message("m2", { text: "Second" }) },
    [`GET ${GMAIL}/messages/m1/attachments/att-m1`]: { body: { size: 5, data: b64("JPEG!") } },
    [`POST ${GMAIL}/messages/batchModify`]: { status: 204 },
  });
  const result = await runSync({ rpc: world.db.rpc, upload: world.upload, fetch: google.fetchFn, oauth: oauthConfig, sleep: noSleep });
  assertEquals(result, { ran: true, imported: 2, skipped: 0, remaining: 0, error: null, attention: false });
  assertEquals(google.requests.find((r) => r.path.endsWith("/messages") && r.method === "GET")!.query.get("q"), "in:inbox newer_than:30d");
  assertEquals(world.imported.map((p) => p.gmail_message_id), ["m1", "m2"], "oldest first");
  assertEquals(world.imported[0].attachments, [{ filename: "receipt.jpg", mime_type: "image/jpeg", size_bytes: 5, content_id: null, is_inline: false, storage_path: "messages/m1/0" }]);
  assertEquals(world.uploads.map((u) => [u.path, new TextDecoder().decode(u.bytes), u.contentType]), [["messages/m1/0", "JPEG!", "image/jpeg"]]);
  const label = google.requests.find((r) => r.path.endsWith("/batchModify"))!;
  assertEquals(label.body, { ids: ["m1", "m2"], addLabelIds: ["Label_7"] });
  assertEquals(world.db.of("office_inbox_finish_sync")[0].args, { p_history_id: "500", p_imported: 2, p_error: null, p_attention: false, p_reset_history: false });
  assertNothingDeleted(google.requests);
});

Deno.test("runSync, history: follows pages, skips spam, drafts and known mail, and only moves the bookmark when done", async () => {
  const world = syncWorld({ historyId: "100", known: ["k1"] });
  const google = fakeGoogle({
    [TOKEN]: { body: { access_token: "at" } },
    [`GET ${GMAIL}/history`]: (req) => req.query.get("pageToken") === "p2"
      ? { body: { historyId: "130", history: [{ id: "121", messagesAdded: [{ message: { id: "n2", threadId: "t", labelIds: ["SENT"] } }] }] } }
      : { body: { historyId: "120", nextPageToken: "p2", history: [{ id: "101", messagesAdded: [
          { message: { id: "n1", threadId: "t", labelIds: ["INBOX"] } },
          { message: { id: "s1", threadId: "s", labelIds: ["SPAM"] } },
          { message: { id: "d1", threadId: "d", labelIds: ["DRAFT"] } },
          { message: { id: "k1", threadId: "k", labelIds: ["INBOX"] } }] }] } },
    [`GET ${GMAIL}/messages/n1`]: { body: message("n1", { threadId: "t", text: "Hi" }) },
    [`GET ${GMAIL}/messages/n2`]: { body: message("n2", { threadId: "t", from: "office@veritasvillage.org", text: "Reply from Gmail", labels: ["SENT"] }) },
    [`POST ${GMAIL}/messages/batchModify`]: { status: 204 },
  });
  const result = await runSync({ rpc: world.db.rpc, upload: world.upload, fetch: google.fetchFn, oauth: oauthConfig, sleep: noSleep });
  assertEquals(result.imported, 2);
  assertEquals(google.requests[1].query.get("startHistoryId"), "100");
  assertEquals(google.requests[1].query.get("historyTypes"), "messageAdded");
  assertEquals(world.db.of("office_inbox_known_messages")[0].args.p_ids, ["n1", "k1", "n2"]);
  assertEquals(world.imported.map((p) => [p.gmail_message_id, p.direction]), [["n1", "inbound"], ["n2", "outbound"]]);
  assertEquals(world.db.of("office_inbox_finish_sync")[0].args.p_history_id, "130");

  // More than one run's worth: the bookmark stays put so the rest is picked up next time.
  const busy = syncWorld({ historyId: "100" });
  const many = fakeGoogle({
    [TOKEN]: { body: { access_token: "at" } },
    [`GET ${GMAIL}/history`]: { body: { historyId: "200", history: [{ id: "1", messagesAdded: ["a", "b", "c"].map((id) => ({ message: { id, threadId: id, labelIds: ["INBOX"] } })) }] } },
    [`GET ${GMAIL}/messages/*`]: (req) => ({ body: message(req.path.split("/").pop()!, { text: "x" }) }),
    [`POST ${GMAIL}/messages/batchModify`]: { status: 204 },
  });
  const partial = await runSync({ rpc: busy.db.rpc, upload: busy.upload, fetch: many.fetchFn, oauth: oauthConfig, sleep: noSleep, perRun: 2 });
  assertEquals([partial.imported, partial.remaining], [2, 1]);
  assertEquals(busy.db.of("office_inbox_finish_sync")[0].args.p_history_id, null);
});

Deno.test("runSync: a bookmark Gmail no longer knows starts over from the last week", async () => {
  const world = syncWorld({ historyId: "1" });
  const google = fakeGoogle({
    [TOKEN]: { body: { access_token: "at" } },
    [`GET ${GMAIL}/history`]: { status: 404, body: { error: { message: "Requested entity was not found." } } },
    [`GET ${GMAIL}/profile`]: { body: { emailAddress: "office@veritasvillage.org", historyId: "900" } },
    [`GET ${GMAIL}/messages`]: { body: { messages: [] } },
  });
  const result = await runSync({ rpc: world.db.rpc, upload: world.upload, fetch: google.fetchFn, oauth: oauthConfig, sleep: noSleep });
  assertEquals(result.error, null);
  assertEquals(google.requests.find((r) => r.path.endsWith("/messages"))!.query.get("q"), "in:inbox newer_than:7d");
  assertEquals(world.db.of("office_inbox_finish_sync")[0].args.p_history_id, "900");
});

Deno.test("runSync: a refused refresh token marks the connection for attention; an outage does not", async () => {
  const world = syncWorld();
  const revoked = fakeGoogle({ [TOKEN]: { status: 400, body: { error: "invalid_grant" } } });
  const result = await runSync({ rpc: world.db.rpc, upload: world.upload, fetch: revoked.fetchFn, oauth: oauthConfig, sleep: noSleep });
  assert(result.attention);
  assertEquals(world.db.of("office_inbox_finish_sync")[0].args.p_attention, true);
  assertEquals(world.imported.length, 0);

  const outage = syncWorld();
  const down = fakeGoogle({ [TOKEN]: { body: { access_token: "at" } }, [`GET ${GMAIL}/profile`]: { status: 503 } });
  const second = await runSync({ rpc: outage.db.rpc, upload: outage.upload, fetch: down.fetchFn, oauth: oauthConfig, sleep: noSleep });
  assertFalse(second.attention);
  assertStringIncludes(second.error!, "503");
  assertEquals(outage.db.of("office_inbox_finish_sync")[0].args.p_attention, false);
});

Deno.test("runSync: does nothing when another run holds the lease or the mailbox is not connected", async () => {
  const db = fakeDb({ office_inbox_claim_sync: () => null });
  const google = fakeGoogle({});
  const result = await runSync({ rpc: db.rpc, upload: () => Promise.resolve({ error: null }), fetch: google.fetchFn, oauth: oauthConfig });
  assertFalse(result.ran);
  assertEquals(google.requests.length, 0);
});

// --- sending ---------------------------------------------------------------------------------------------------
function sendWorld(begin: any) {
  return fakeDb({
    office_inbox_begin_send: () => begin,
    read_vault_secret: () => "rt-1",
    office_inbox_finish_send: () => null,
  });
}
const beginAnswer = {
  send_id: "s1", to: "ann@example.org", from_address: "office@veritasvillage.org", from_name: "Veritas Village",
  subject: "Field trip", gmail_thread_id: "t1", in_reply_to: "<m2@mail.example.org>", references: "<m1@mail.example.org>",
};
const input = { userId: "u1", threadId: "11111111-1111-1111-1111-111111111111", body: "See you Friday.", clientKey: "22222222-2222-2222-2222-222222222222", nextStatus: "waiting" as const };

Deno.test("sendReply: sends in the Gmail thread with threading headers, then records Gmail's ids", async () => {
  const db = sendWorld(beginAnswer);
  const google = fakeGoogle({
    [TOKEN]: { body: { access_token: "at" } },
    [`POST ${GMAIL}/messages/send`]: { body: { id: "g-sent", threadId: "t1", labelIds: ["SENT"] } },
    [`GET ${GMAIL}/messages/g-sent`]: { body: { id: "g-sent", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<gmail-made@mail.gmail.com>" }] } } },
  });
  const result = await sendReply({ rpc: db.rpc, fetch: google.fetchFn, oauth: oauthConfig, sleep: noSleep }, input);
  assertEquals(result, { ok: true, duplicate: false, to: "ann@example.org" });
  const send = google.requests.find((r) => r.path.endsWith("/messages/send"))!;
  assertEquals(send.body.threadId, "t1");
  const raw = decodeRaw(send.body.raw);
  assertStringIncludes(raw, "In-Reply-To: <m2@mail.example.org>\r\n");
  assertStringIncludes(raw, "References: <m1@mail.example.org> <m2@mail.example.org>\r\n");
  assertStringIncludes(raw, "Subject: Re: Field trip\r\n");
  assertStringIncludes(raw, "To: ann@example.org\r\n");
  const finish = db.of("office_inbox_finish_send")[0].args;
  assertEquals([finish.p_send, finish.p_ok, finish.p_gmail_message_id, finish.p_rfc_message_id, finish.p_subject], ["s1", true, "g-sent", "<gmail-made@mail.gmail.com>", "Re: Field trip"]);
  assertEquals(db.of("office_inbox_begin_send")[0].args.p_user, "u1");
  assertNothingDeleted(google.requests);
});

Deno.test("sendReply: a repeated click sends nothing; a refusal (limits, wrong person) sends nothing; a Gmail failure is recorded", async () => {
  const google = fakeGoogle({});
  const dup = await sendReply({ rpc: sendWorld({ duplicate: true, send_id: "s1", status: "sent" }).rpc, fetch: google.fetchFn, oauth: oauthConfig }, input);
  assertEquals(dup, { ok: true, duplicate: true });

  const refused = fakeDb({ office_inbox_begin_send: () => ({ __error: "You have sent 20 replies in the last hour. Wait a little before sending more." }) });
  await assertRejects(() => sendReply({ rpc: refused.rpc, fetch: google.fetchFn, oauth: oauthConfig }, input), ReplyRefused, "20 replies");
  assertEquals(google.requests.length, 0, "Google was never called");

  const db = sendWorld(beginAnswer);
  const failing = fakeGoogle({ [TOKEN]: { body: { access_token: "at" } }, [`POST ${GMAIL}/messages/send`]: { status: 400, body: { error: { message: "Invalid To header" } } } });
  const result = await sendReply({ rpc: db.rpc, fetch: failing.fetchFn, oauth: oauthConfig, sleep: noSleep }, input);
  assertFalse(result.ok);
  const finish = db.of("office_inbox_finish_send")[0].args;
  assertEquals(finish.p_ok, false);
  assertStringIncludes(finish.p_error, "Invalid To header");

  const revoked = sendWorld(beginAnswer);
  const noAuth = fakeGoogle({ [TOKEN]: { status: 400, body: { error: "invalid_grant" } } });
  const r2 = await sendReply({ rpc: revoked.rpc, fetch: noAuth.fetchFn, oauth: oauthConfig }, input);
  assert(!r2.ok && r2.error.includes("Reconnect the office inbox"));
});

// --- configuration -------------------------------------------------------------------------------------------------
Deno.test("loadInboxConfig: names every missing secret and builds the redirect address", () => {
  const missing = loadInboxConfig(() => undefined);
  assert(!missing.ok);
  assertEquals(missing.missing, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OFFICE_INBOX_ADDRESS", "PORTAL_SITE_URL", "SUPABASE_URL"]);
  const env: Record<string, string> = {
    GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s", OFFICE_INBOX_ADDRESS: " Office@VeritasVillage.org ",
    PORTAL_SITE_URL: "https://staging.veritasvillage.org/", SUPABASE_URL: "https://axfikwoazkvtnwcgpyhg.supabase.co",
  };
  const ok = loadInboxConfig((n) => env[n]);
  assert(ok.ok);
  assertEquals(ok.config.mailbox, "office@veritasvillage.org");
  assertEquals(ok.config.siteUrl, "https://staging.veritasvillage.org");
  assertEquals(ok.config.redirectUri, "https://axfikwoazkvtnwcgpyhg.supabase.co/functions/v1/office-inbox-oauth");
  const bad = loadInboxConfig((n) => ({ ...env, PORTAL_SITE_URL: "http://evil.example/path" })[n]);
  assert(!bad.ok && bad.missing[0].startsWith("PORTAL_SITE_URL"));
});
