/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import { safeEqual } from "./crypto.ts";
import { escapeHtml } from "./email-template.ts";
import { buildInviteEmail } from "./invite-email.ts";
import { safePath } from "./paths.ts";
import { needsMfaStepUp } from "./aal.ts";
import { corsHeaders, json } from "./http.ts";

Deno.test("safeEqual: equal strings match, any difference or length change does not", () => {
  assert(safeEqual("secret", "secret"));
  assertFalse(safeEqual("secret", "secreT"));
  assertFalse(safeEqual("secret", "secre"));
  assertFalse(safeEqual("secret", "secrets"));
  assertFalse(safeEqual("", "x"));
  assert(safeEqual("", ""));
});

Deno.test("escapeHtml: escapes the five characters that can break out of markup", () => {
  assertEquals(escapeHtml(`<b onclick="x">Tom & 'Jerry'</b>`), "&lt;b onclick=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;");
});

Deno.test("safePath: only same-site paths survive; everything else is the home page", () => {
  assertEquals(safePath("/family-village/teacher"), "/family-village/teacher");
  assertEquals(safePath("/family-village/home?tab=2"), "/family-village/home?tab=2");
  const home = "/family-village/home";
  assertEquals(safePath(null), home);
  assertEquals(safePath(undefined), home);
  assertEquals(safePath(""), home);
  assertEquals(safePath("https://evil.example/x"), home);
  assertEquals(safePath("//evil.example/x"), home);
  assertEquals(safePath("/\\evil.example/x"), home);
  assertEquals(safePath("javascript:alert(1)"), home);
  assertEquals(safePath("family-village/home"), home);
});

Deno.test("needsMfaStepUp: only a session that must reach aal2 and has not yet does", async () => {
  const client = (data: unknown) => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: () => Promise.resolve({ data }) } } }) as never;
  assertEquals(await needsMfaStepUp(client({ currentLevel: "aal1", nextLevel: "aal2" })), true);
  assertEquals(await needsMfaStepUp(client({ currentLevel: "aal2", nextLevel: "aal2" })), false);
  assertEquals(await needsMfaStepUp(client({ currentLevel: "aal1", nextLevel: "aal1" })), false);
  assertEquals(await needsMfaStepUp(client(null)), false);
});

Deno.test("json: sets status, content type and the CORS headers browsers need", async () => {
  const response = json({ ok: true }, 403);
  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Content-Type"), "application/json");
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), corsHeaders["Access-Control-Allow-Origin"]);
  assertEquals(await response.json(), { ok: true });
});

Deno.test("buildInviteEmail: escapes typed names and notes, keeps line breaks, links the CTA", () => {
  const html = buildInviteEmail({
    adminName: `<script>alert(1)</script>`, familyName: "Smith & Sons", existingHousehold: false,
    note: "Line one\nLine <b>two</b>", actionLink: "https://example.test/accept?t=1",
  });
  assertFalse(html.includes("<script>alert(1)</script>"));
  assertStringIncludes(html, "&lt;script&gt;");
  assertStringIncludes(html, "Line one<br>Line &lt;b&gt;two&lt;/b&gt;");
  assertStringIncludes(html, "https://example.test/accept?t=1");
  assertStringIncludes(html, "your family at the table");
});

Deno.test("buildInviteEmail: an existing-household invite names the household", () => {
  const html = buildInviteEmail({ adminName: "Jordan", familyName: "Lewis", existingHousehold: true, actionLink: "https://example.test/a" });
  assertStringIncludes(html, "<b>Lewis</b> household");
  assertStringIncludes(html, "a place for you at the table");
});
