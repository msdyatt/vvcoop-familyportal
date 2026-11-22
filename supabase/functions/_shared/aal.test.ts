/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { bearerToken, needsMfaStepUp } from "./aal.ts";

// These tests use a real supabase-js client, built the same way every edge
// function builds its user client: a forwarded Authorization header and no
// stored session. Only the network is faked. A mocked client is what hid
// issue #161 (the check read the empty stored session and always passed).

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (aal: "aal1" | "aal2") =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "user-1", role: "authenticated", aal, amr: [{ method: "password", timestamp: 1 }], exp: 9999999999 })}.${b64url("signature")}`;

type Factor = { id: string; status: "verified" | "unverified"; factor_type: "totp" };

function realShapedClient(authorization: string, factors: Factor[], userStatus = 200) {
  const seen: string[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seen.push(`${url.pathname} ${headers.get("Authorization") ?? ""}`);
    if (url.pathname === "/auth/v1/user") {
      if (userStatus !== 200) return Promise.resolve(new Response(JSON.stringify({ code: userStatus, msg: "bad jwt" }), { status: userStatus, headers: { "Content-Type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ id: "user-1", aud: "authenticated", role: "authenticated", email: "admin@example.test", factors, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
  const client = createClient("https://project.supabase.test", "publishable-key", { global: { headers: { Authorization: authorization }, fetch: fakeFetch } });
  return { client, seen };
}

const totp: Factor = { id: "f1", status: "verified", factor_type: "totp" };

Deno.test("needsMfaStepUp: an aal1 token from an account with a verified factor is refused", async () => {
  const authorization = `Bearer ${token("aal1")}`;
  const { client, seen } = realShapedClient(authorization, [totp]);
  assertEquals(await needsMfaStepUp(client, authorization), true);
  // The user lookup used the caller's own token, not the publishable key.
  assertEquals(seen, [`/auth/v1/user Bearer ${token("aal1")}`]);
});

Deno.test("needsMfaStepUp: an aal2 token from the same account passes", async () => {
  const authorization = `Bearer ${token("aal2")}`;
  const { client } = realShapedClient(authorization, [totp]);
  assertEquals(await needsMfaStepUp(client, authorization), false);
});

Deno.test("needsMfaStepUp: an aal1 token with no verified factor passes", async () => {
  for (const factors of [[], [{ ...totp, status: "unverified" as const }]]) {
    const authorization = `Bearer ${token("aal1")}`;
    const { client } = realShapedClient(authorization, factors);
    assertEquals(await needsMfaStepUp(client, authorization), false);
  }
});

Deno.test("needsMfaStepUp: fails closed when auth errors or there is no token", async () => {
  const authorization = `Bearer ${token("aal1")}`;
  const { client } = realShapedClient(authorization, [totp], 401);
  assertEquals(await needsMfaStepUp(client, authorization), true);
  const { client: noToken } = realShapedClient("", []);
  assertEquals(await needsMfaStepUp(noToken, null), true);
  assertEquals(await needsMfaStepUp(noToken, "Bearer "), true);
});

Deno.test("bearerToken: strips the scheme in any case and trims", () => {
  assertEquals(bearerToken("Bearer abc"), "abc");
  assertEquals(bearerToken("bearer  abc "), "abc");
  assertEquals(bearerToken(null), "");
});
