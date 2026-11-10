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

test("serves the public homepage without the shared password", async () => {
  const response = await request("/", { headers: { accept: "text/html" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Learning in truth/);
  assert.match(html, /42-2025384/);
  assert.match(html, /lockup-horizontal-navy/);
  assert.doesNotMatch(html, /This site is password protected/);
  assert.doesNotMatch(html, /Friday Co-op/i);
});

test("keeps non-public application routes behind the shared-password gate", async () => {
  const response = await request("/internal-preview", { headers: { accept: "text/html" } });
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /This site is password protected/);
  assert.match(html, /action="\/site-access"/);
  assert.doesNotMatch(html, /SITE_PASSWORD|SITE_AUTH_SECRET/);
});

test("server-renders the branded public home", async () => {
  const response = await request("/", {
    headers: { accept: "text/html" },
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

test("serves distinct, navigable nonprofit verification pages publicly", async () => {
  const cases = [
    ["/about", /A village built by families\./],
    ["/programs", /A shared foundation, many discoveries\./],
    ["/contact", /Get in touch\./],
  ];
  for (const [path, heading] of cases) {
    const response = await request(path, { headers: { accept: "text/html" } });
    assert.equal(response.status, 200, `${path} is public`);
    const html = await response.text();
    assert.match(html, heading);
    assert.match(html, /href="\/about"/);
    assert.match(html, /href="\/programs"/);
    assert.match(html, /href="\/contact"/);
    assert.doesNotMatch(html, /This site is password protected/);
  }
});

test("displays nonprofit identity and administrative contact details", async () => {
  for (const path of ["/about", "/contact"]) {
    const response = await request(path, { headers: { accept: "text/html" } });
    const html = await response.text();
    assert.match(html, /42-2025384/);
    assert.match(html, /509 Las Colinas Drive/);
    assert.match(html, /Leander, Texas/);
    assert.match(html, /VERITAS VILLAGE/);
    assert.match(html, /family\.veritasvillage\.org\/family-village/);
  }
});
