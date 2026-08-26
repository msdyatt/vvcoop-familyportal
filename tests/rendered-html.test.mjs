import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

async function request(path, init = {}) {
  return (await worker()).fetch(new Request(`http://localhost${path}`, init), env, ctx);
}

async function accessCookie() {
  const body = new URLSearchParams({ password: env.SITE_PASSWORD, return_to: "/" });
  const response = await request("/site-access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("vv_site_access="));
  return cookie;
}

test("keeps the public site behind the shared-password gate", async () => {
  const response = await request("/", { headers: { accept: "text/html" } });
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /This site is password protected/);
  assert.match(html, /action="\/site-access"/);
  assert.doesNotMatch(html, /SITE_PASSWORD|SITE_AUTH_SECRET/);
});

test("server-renders the branded public home after gate access", async () => {
  const response = await request("/", {
    headers: { accept: "text/html", cookie: await accessCookie() },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Learning in truth/);
  assert.match(html, /Lately at the co-op/);
  assert.match(html, /lockup-horizontal-navy/);
  assert.doesNotMatch(html, /Friday Co-op/i);
});

test("renders a focused email-and-password portal entry", async () => {
  const response = await request("/family-village", { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Everything your family/);
  assert.match(html, /Back to homepage/);
  assert.match(html, /First time here\? Request an account/);
  assert.doesNotMatch(html, />Google</);
  assert.doesNotMatch(html, />Apple</);

  const [invitationFunction, packageJson] = await Promise.all([
    readFile(new URL("../supabase/functions/invite-family-admin/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(invitationFunction, /https:\/\/family\.veritasvillage\.org\/family-village\/accept-invite/);
  assert.doesNotMatch(invitationFunction, /chatgpt\.site/);
  assert.match(packageJson, /"xss": "1\.0\.15"/);
  assert.doesNotMatch(packageJson, /sanitize-html/);
});
