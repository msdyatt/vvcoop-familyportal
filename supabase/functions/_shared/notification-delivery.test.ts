/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { buildEmail, parseAllowList, processDeliveries, type ClaimedDelivery, type Deps, type Outcome } from "./notification-delivery.ts";
import { withOpenMarker } from "./paths.ts";
import { decidePush, type Access } from "./push-plan.ts";
import { sendViaResend } from "./resend.ts";
import { buildSmsBody, PROVIDERS, resolveSmsProvider, SMS_FOOTER, stubSmsProvider, type SmsMessage, type SmsProvider, type SmsResult } from "./sms.ts";

const row = (over: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  delivery_id: "d1", notification_id: "n1", user_id: "u1", channel: "email", attempt: 1,
  destination: "parent@example.com", kind: "broadcast_important", title: "Class moves to Room 4",
  body: "Please use the side door.", link_path: "/family-village/home", urgent: false, ...over,
});

/** A fake texting provider that records what it was asked to send. It never touches the network. */
function fakeSms(result: SmsResult = { ok: true, id: "SM123" }, live = true): SmsProvider & { sent: SmsMessage[] } {
  const sent: SmsMessage[] = [];
  return { name: "fake", live, sent, send(message) { sent.push(message); return Promise.resolve(result); } };
}

function harness(over: Partial<Deps> = {}) {
  const emails: { to: string; subject: string; html: string }[] = [];
  const finished: { id: string; outcome: Outcome }[] = [];
  const deps: Deps = {
    sms: fakeSms(),
    sendEmail: (r, message) => { emails.push({ to: r.destination, ...message }); return Promise.resolve({ status: "sent", provider: "fake-mail", messageId: "m1" }); },
    finish: (r, outcome) => { finished.push({ id: r.delivery_id, outcome }); return Promise.resolve(); },
    ...over,
  };
  return { deps, emails, finished };
}

Deno.test("withOpenMarker: the notification id rides on the link, before any #fragment, and only on this site", () => {
  assertEquals(withOpenMarker("/family-village/home", "abc"), "/family-village/home?vvn=abc");
  assertEquals(withOpenMarker("/family-village/news?tab=2", "abc"), "/family-village/news?tab=2&vvn=abc");
  assertEquals(withOpenMarker("/family-village/news#top", "abc"), "/family-village/news?vvn=abc#top");
  assertEquals(withOpenMarker("https://evil.example/x", "abc"), "/family-village/home?vvn=abc");
  assertEquals(withOpenMarker(null, "a b"), "/family-village/home?vvn=a%20b");
});

Deno.test("decidePush: inactive people, switched-off push and quiet mode are never sent to; urgent beats quiet", () => {
  const ok: Access = { user_id: "u", active: true, push_ok: true, has_device: true, quiet: false };
  assertEquals(decidePush(ok, "message"), { send: true });
  assertEquals(decidePush(undefined, "message"), { send: false, reason: "inactive" });
  assertEquals(decidePush({ ...ok, active: false, push_ok: false }, "message"), { send: false, reason: "inactive" });
  assertEquals(decidePush({ ...ok, has_device: false, push_ok: false }, "message"), { send: false, reason: "no_device" });
  assertEquals(decidePush({ ...ok, push_ok: false }, "message"), { send: false, reason: "push_disabled" });
  assertEquals(decidePush({ ...ok, quiet: true }, "message"), { send: false, reason: "quiet_mode" });
  assertEquals(decidePush({ ...ok, quiet: true }, "broadcast_urgent"), { send: true });
});

Deno.test("buildSmsBody: always names the sender, always carries STOP/HELP, stays short and plain", () => {
  const body = buildSmsBody({ title: "Closed today", body: "Snow – stay home. “See you Monday” 😀", urgent: true });
  assertStringIncludes(body, "URGENT - Veritas Village: Closed today");
  assertStringIncludes(body, 'Snow - stay home. "See you Monday"');
  assert(body.endsWith(SMS_FOOTER));
  assertFalse(/[^\x20-\x7E]/.test(body), "plain characters only");
  const long = buildSmsBody({ title: "T", body: "word ".repeat(200), urgent: false });
  assert(long.length <= 300, `kept to two segments, was ${long.length}`);
  assert(long.endsWith(SMS_FOOTER), "the opt-out line survives truncation");
  assertStringIncludes(long, "...");
});

Deno.test("the stub texting provider sends nothing and never touches the network", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the stub must not use the network"); };
  try {
    assertFalse(stubSmsProvider.live);
    const result = await stubSmsProvider.send({ to: "+15555550100", body: "hi", idempotencyKey: "k" });
    assertEquals(result.ok, false);
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("resolveSmsProvider: an unknown provider, or a known one with no key, falls back to the stub", () => {
  assertEquals(resolveSmsProvider("stub", null), stubSmsProvider);
  assertEquals(resolveSmsProvider("nobody", "key"), stubSmsProvider);
  PROVIDERS["fake_provider"] = () => fakeSms();
  try {
    assertEquals(resolveSmsProvider("fake_provider", null), stubSmsProvider);
    assertEquals(resolveSmsProvider("fake_provider", "key").name, "fake");
  } finally { delete PROVIDERS["fake_provider"]; }
});

Deno.test("buildEmail: the title and body are escaped, urgent says so, and the link stays on this site", () => {
  const mail = buildEmail(row({ title: "<b>Hi</b> & bye", body: "Line one\n\nLine <two>", urgent: true, kind: "broadcast_urgent", link_path: "https://evil.example" }));
  assertEquals(mail.subject, "URGENT: <b>Hi</b> & bye");
  assertStringIncludes(mail.html, "&lt;b&gt;Hi&lt;/b&gt; &amp; bye");
  assertStringIncludes(mail.html, "Line &lt;two&gt;");
  assertFalse(mail.html.includes("<b>Hi</b>"));
  assertStringIncludes(mail.html, "Urgent alert");
  assertStringIncludes(mail.html, 'href="https://family.veritasvillage.org/family-village/home"');
  assertFalse(mail.html.includes("evil.example"));
});

Deno.test("processDeliveries: an email is built, sent once and reported", async () => {
  const { deps, emails, finished } = harness();
  const tally = await processDeliveries([row()], deps);
  assertEquals(tally, { sent: 1, failed: 0, skipped: 0 });
  assertEquals(emails.length, 1);
  assertEquals(emails[0].to, "parent@example.com");
  assertEquals(finished, [{ id: "d1", outcome: { status: "sent", provider: "fake-mail", messageId: "m1" } }]);
});

Deno.test("processDeliveries: with the stub provider a text is skipped, not failed, and nothing is sent", async () => {
  const { deps, finished } = harness({ sms: stubSmsProvider });
  const tally = await processDeliveries([row({ channel: "sms", destination: "+15555550100", delivery_id: "t1" })], deps);
  assertEquals(tally, { sent: 0, failed: 0, skipped: 1 });
  assertEquals(finished[0].outcome, { status: "skipped", provider: "stub", reason: "provider_not_set_up" });
});

Deno.test("processDeliveries: a live provider gets the text with the delivery id as its idempotency key", async () => {
  const sms = fakeSms();
  const { deps, finished } = harness({ sms });
  await processDeliveries([row({ channel: "sms", destination: "+15555550100", delivery_id: "t1", urgent: true })], deps);
  assertEquals(sms.sent.length, 1);
  assertEquals(sms.sent[0].to, "+15555550100");
  assertEquals(sms.sent[0].idempotencyKey, "t1");
  assert(sms.sent[0].body.startsWith("URGENT - Veritas Village:"));
  assertEquals(finished[0].outcome, { status: "sent", provider: "fake", messageId: "SM123" });
});

Deno.test("processDeliveries: a permanent text failure is not retryable; a temporary one is", async () => {
  for (const [permanent, retryable] of [[true, false], [false, true]] as const) {
    const { deps, finished } = harness({ sms: fakeSms({ ok: false, error: "nope", permanent }) });
    const tally = await processDeliveries([row({ channel: "sms", destination: "+15555550100" })], deps);
    assertEquals(tally.failed, 1);
    assertEquals(finished[0].outcome, { status: "failed", provider: "fake", error: "nope", retryable });
  }
});

Deno.test("processDeliveries: a row whose send throws is failed (and retryable), and the others still go", async () => {
  const sent: string[] = [];
  const { deps, finished } = harness({
    sendEmail: (r) => {
      if (r.delivery_id === "bad") throw new Error("boom");
      sent.push(r.delivery_id);
      return Promise.resolve({ status: "sent", provider: "x", messageId: null });
    },
  });
  const tally = await processDeliveries([row({ delivery_id: "a" }), row({ delivery_id: "bad" }), row({ delivery_id: "c" })], deps);
  assertEquals(tally, { sent: 2, failed: 1, skipped: 0 });
  assertEquals(sent.sort(), ["a", "c"]);
  assertEquals(finished.find((f) => f.id === "bad")?.outcome, { status: "failed", provider: null, error: "boom", retryable: true });
});

Deno.test("processDeliveries: the allow-list keeps a dry run away from real people", async () => {
  const sms = fakeSms();
  const { deps, emails, finished } = harness({ sms, allowList: parseAllowList("Sam@Example.com, +15555550199") });
  const tally = await processDeliveries([
    row({ delivery_id: "e1", destination: "sam@example.com" }),
    row({ delivery_id: "e2", destination: "parent@example.com" }),
    row({ delivery_id: "t1", channel: "sms", destination: "+15555550199" }),
    row({ delivery_id: "t2", channel: "sms", destination: "+15555550100" }),
  ], deps);
  assertEquals(tally, { sent: 2, failed: 0, skipped: 2 });
  assertEquals(emails.map((e) => e.to), ["sam@example.com"]);
  assertEquals(sms.sent.map((m) => m.to), ["+15555550199"]);
  assertEquals(finished.filter((f) => f.outcome.status === "skipped").map((f) => (f.outcome as { reason: string }).reason), ["not_on_allowlist", "not_on_allowlist"]);
  assertEquals(parseAllowList(""), null);
  assertEquals(parseAllowList(undefined), null);
});

Deno.test("processDeliveries: a failure to report back does not stop the run", async () => {
  const { deps } = harness({ finish: () => Promise.reject(new Error("db down")) });
  const tally = await processDeliveries([row({ delivery_id: "a" }), row({ delivery_id: "b" })], deps);
  assertEquals(tally.sent, 2);
});

// --- the Resend call, with a fake network -------------------------------------------------------
async function withFakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, run: (calls: { url: string; init: RequestInit }[]) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(handler(String(input), init ?? {}));
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = realFetch; }
}

Deno.test("sendViaResend: sends the idempotency key and returns the message id", async () => {
  await withFakeFetch(() => new Response(JSON.stringify({ id: "re_123" }), { status: 200 }), async (calls) => {
    const result = await sendViaResend("key", "Village <a@b.org>", "to@x.org", "Subject", "<p>x</p>", { idempotencyKey: "delivery-1" });
    assertEquals(result, { ok: true, id: "re_123" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    assertEquals(headers["Idempotency-Key"], "delivery-1");
    assertEquals(headers.Authorization, "Bearer key");
    assertEquals(JSON.parse(String(calls[0].init.body)), { from: "Village <a@b.org>", to: "to@x.org", subject: "Subject", html: "<p>x</p>" });
  });
});

Deno.test("sendViaResend: a rejected address is not retryable; rate limits, server errors and network trouble are", async () => {
  for (const [status, retryable] of [[422, false], [400, false], [403, false], [429, true], [500, true], [503, true]] as const) {
    await withFakeFetch(() => new Response("{}", { status }), async () => {
      const result = await sendViaResend("k", "f", "t", "s", "h");
      assert(!result.ok);
      assertEquals(result.retryable, retryable, `status ${status}`);
    });
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("socket closed"));
  try {
    const result = await sendViaResend("k", "f", "t", "s", "h");
    assert(!result.ok);
    assert(result.retryable);
    assertStringIncludes(result.error, "socket closed");
  } finally { globalThis.fetch = realFetch; }
});

Deno.test("sendViaResend: no Idempotency-Key header unless one is given (existing callers are unchanged)", async () => {
  await withFakeFetch(() => new Response("{}", { status: 200 }), async (calls) => {
    await sendViaResend("k", "f", "t", "s", "h");
    assertFalse("Idempotency-Key" in (calls[0].init.headers as Record<string, string>));
  });
});
