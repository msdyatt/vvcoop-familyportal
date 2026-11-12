import assert from "node:assert/strict";
import test from "node:test";

// Exercises the built Worker (dist/server/index.js, same as rendered-html.test.mjs)
// end to end: the /calendar/feed route, answered ahead of the password gate.
// Upstream (the Supabase edge function) is replaced by a stubbed global fetch,
// so nothing here touches the network.

const TOKEN = "11111111-2222-4333-8444-555555555555";
const CLASS_ID = "99999999-8888-4777-8666-444444444444";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Veritas Village//EN\r\nEND:VCALENDAR\r\n";
const UPSTREAM_BASE = "https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/calendar-feed";

const env = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  SITE_PASSWORD: "test-only-password",
  SITE_AUTH_SECRET: "test-only-secret",
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

/**
 * Runs `fn` with fetch stubbed and every console method captured. Returns the
 * stub's recorded upstream calls and everything logged.
 */
async function withStubs(upstream, fn) {
  const calls = [];
  const logs = [];
  const realFetch = globalThis.fetch;
  const realConsole = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    realConsole[level] = console[level];
    console[level] = (...args) => logs.push(args.map(String).join(" "));
  }
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return typeof upstream === "function" ? upstream(String(input), init) : upstream;
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const level of Object.keys(realConsole)) console[level] = realConsole[level];
  }
  return { calls, logs };
}

const feedResponse = () => new Response(ICS, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8" } });

async function get(path, init = {}, workerEnv = env) {
  return (await worker()).fetch(new Request(`http://localhost${path}`, init), workerEnv, ctx);
}

test("feed route is answered without the shared password, while other routes stay gated", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    const feed = await get("/calendar/feed?scope=public");
    assert.equal(feed.status, 200);
    assert.equal(await feed.text(), ICS);

    const gated = await get("/internal-preview", { headers: { accept: "text/html" } });
    assert.equal(gated.status, 401);
  });
  assert.equal(calls.length, 1);
});

test("feed route still works when the gate would fail closed (no password configured)", async () => {
  await withStubs(feedResponse, async () => {
    const bare = { ASSETS: env.ASSETS };
    assert.equal((await get("/calendar/feed?scope=public", {}, bare)).status, 200);
    assert.equal((await get("/internal-preview", {}, bare)).status, 503);
  });
});

test("public scope: fetches the edge function and returns its status, body and content type", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    const response = await get("/calendar/feed?scope=public");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.equal(await response.text(), ICS);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM_BASE}?scope=public`);
  assert.equal(calls[0].init.method, "GET");
});

test("class and personal scopes forward scope, id and token, and are cached privately", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    const klass = await get(`/calendar/feed?scope=class&id=${CLASS_ID}&token=${TOKEN}`);
    assert.equal(klass.status, 200);
    assert.equal(klass.headers.get("cache-control"), "private, max-age=300");
    const personal = await get(`/calendar/feed?scope=personal&token=${TOKEN}`);
    assert.equal(personal.status, 200);
    assert.equal(personal.headers.get("cache-control"), "private, max-age=300");
  });
  const first = new URL(calls[0].url);
  assert.deepEqual(Object.fromEntries(first.searchParams), { scope: "class", id: CLASS_ID, token: TOKEN });
  const second = new URL(calls[1].url);
  assert.deepEqual(Object.fromEntries(second.searchParams), { scope: "personal", token: TOKEN });
  assert.equal(first.origin + first.pathname, UPSTREAM_BASE);
});

test("upstream errors keep their status and are never cached", async () => {
  const bad = () => new Response("Missing token.", { status: 400, headers: { "Content-Type": "text/plain" } });
  await withStubs(bad, async () => {
    const response = await get("/calendar/feed?scope=personal");
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Missing token.");
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("unknown, repeated and oversized parameters are rejected with 400 and never reach upstream", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    for (const query of [
      "scope=public&extra=1",
      "scope=public&apikey=abc",
      "scope=public&scope=personal",
      `scope=personal&token=${TOKEN}&token=${TOKEN}`,
      `scope=personal&token=${"a".repeat(300)}`,
      "SCOPE=public",
    ]) {
      const response = await get(`/calendar/feed?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    }
  });
  assert.equal(calls.length, 0);
});

test("only GET and HEAD are allowed; everything else is 405 with an Allow header", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await get("/calendar/feed?scope=public", { method, body: ["GET", "HEAD"].includes(method) ? undefined : "x" });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
  });
  assert.equal(calls.length, 0);
});

test("HEAD returns the same status and headers with no body", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    const response = await get("/calendar/feed?scope=public", { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.equal(await response.text(), "");
  });
  // The edge function only answers GET, so HEAD is fetched upstream as GET.
  assert.equal(calls[0].init.method, "GET");
});

test("the caller's cookies and headers are not forwarded, and redirects are not followed", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    await get(`/calendar/feed?scope=personal&token=${TOKEN}`, {
      headers: {
        cookie: "vv_site_access=secret-session; sb-access-token=abc",
        authorization: "Bearer caller-jwt",
        "x-forwarded-for": "203.0.113.9",
        referer: "https://example.com/",
      },
    });
  });
  const headers = new Headers(calls[0].init.headers);
  for (const name of ["cookie", "authorization", "x-forwarded-for", "referer", "apikey"]) {
    assert.equal(headers.has(name), false, `${name} must not be forwarded`);
  }
  assert.equal(calls[0].init.redirect, "manual");
  assert.ok(calls[0].init.signal, "a timeout signal is set");
});

test("an upstream redirect is reported as 502, not followed or passed on", async () => {
  await withStubs(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/feed" } }), async () => {
    const response = await get("/calendar/feed?scope=public");
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("upstream failure and timeout become 502 and 504, and the token never reaches the logs", async () => {
  const failing = async (url) => { throw new TypeError(`fetch failed for ${url}`); };
  const timingOut = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };

  const failed = await withStubs(failing, async () => {
    const response = await get(`/calendar/feed?scope=personal&token=${TOKEN}`);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), new RegExp(TOKEN));
  });
  const timed = await withStubs(timingOut, async () => {
    const response = await get(`/calendar/feed?scope=personal&token=${TOKEN}`);
    assert.equal(response.status, 504);
  });
  assert.ok(failed.logs.length > 0 && timed.logs.length > 0, "failures are logged");
  for (const line of [...failed.logs, ...timed.logs]) {
    assert.doesNotMatch(line, new RegExp(TOKEN), "token must not appear in logs");
    assert.doesNotMatch(line, /token=/, "query string must not appear in logs");
  }
});

test("a successful request logs nothing at all", async () => {
  const { logs } = await withStubs(feedResponse, async () => {
    await get(`/calendar/feed?scope=class&id=${CLASS_ID}&token=${TOKEN}`);
  });
  assert.deepEqual(logs, []);
});

test("SUPABASE_URL overrides the default upstream; a non-https value is refused", async () => {
  const custom = await withStubs(feedResponse, async () => {
    const response = await get("/calendar/feed?scope=public", {}, { ...env, SUPABASE_URL: "https://backend.example.org" });
    assert.equal(response.status, 200);
  });
  assert.equal(custom.calls[0].url, "https://backend.example.org/functions/v1/calendar-feed?scope=public");

  const viaPublicVar = await withStubs(feedResponse, async () => {
    await get("/calendar/feed?scope=public", {}, { ...env, NEXT_PUBLIC_SUPABASE_URL: "https://other.example.org/" });
  });
  assert.equal(viaPublicVar.calls[0].url, "https://other.example.org/functions/v1/calendar-feed?scope=public");

  const insecure = await withStubs(feedResponse, async () => {
    const response = await get("/calendar/feed?scope=public", {}, { ...env, SUPABASE_URL: "http://insecure.example.org" });
    assert.equal(response.status, 500);
  });
  assert.equal(insecure.calls.length, 0);
});

test("only the exact path is the feed route", async () => {
  const { calls } = await withStubs(feedResponse, async () => {
    const response = await get("/calendar/feed/extra?scope=public", { headers: { accept: "text/html" } });
    assert.equal(response.status, 401, "any other path still hits the gate");
  });
  assert.equal(calls.length, 0);
});
