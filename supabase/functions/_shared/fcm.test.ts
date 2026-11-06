/// <reference lib="deno.ns" />
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { buildFcmMessage, createServiceJwt, getAccessToken, isDeadToken, resetTokenCache, sendFcm, type ServiceAccount } from "./fcm.ts";

// A throwaway key made for the test; it is not a real Google credential.
async function testAccount(): Promise<{ account: ServiceAccount; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return { account: { project_id: "test-project", client_email: "sender@test-project.iam.gserviceaccount.com", private_key: pem }, publicKey: pair.publicKey };
}

const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

Deno.test("createServiceJwt: a valid RS256 JWT with the right issuer, scope and one-hour life", async () => {
  const { account, publicKey } = await testAccount();
  const jwt = await createServiceJwt(account, 1_000_000);
  const [header, claims, signature] = jwt.split(".");
  assertEquals(JSON.parse(new TextDecoder().decode(fromB64url(header))), { alg: "RS256", typ: "JWT" });
  const parsed = JSON.parse(new TextDecoder().decode(fromB64url(claims)));
  assertEquals(parsed.iss, account.client_email);
  assertEquals(parsed.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assertEquals(parsed.aud, "https://oauth2.googleapis.com/token");
  assertEquals(parsed.exp - parsed.iat, 3600);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64url(signature), new TextEncoder().encode(`${header}.${claims}`));
  assert(ok, "the signature verifies against the matching public key");
});

Deno.test("buildFcmMessage: title and body shown by the phone, url and tag carried for routing the tap", () => {
  const { message } = buildFcmMessage("tok", { title: "Hi", body: "There", url: "/family-village/home", tag: "n1" });
  assertEquals(message.token, "tok");
  assertEquals(message.notification, { title: "Hi", body: "There" });
  assertEquals(message.data, { url: "/family-village/home", tag: "n1" });
  assertEquals(message.android.priority, "HIGH");
  assertEquals(message.apns.headers["apns-priority"], "10");
});

Deno.test("isDeadToken: only a token Google says is gone is deleted; temporary trouble is not", () => {
  assert(isDeadToken(404, { error: { status: "NOT_FOUND" } }));
  assert(isDeadToken(400, { error: { details: [{ errorCode: "UNREGISTERED" }] } }));
  assert(isDeadToken(400, { error: { message: "The registration token is not a valid FCM registration token" } }));
  assertFalse(isDeadToken(400, { error: { message: "Invalid payload" } }));
  assertFalse(isDeadToken(500, null));
  assertFalse(isDeadToken(429, null));
  assertFalse(isDeadToken(401, null));
});

function fakeGoogle(sendStatus: number, sendBody: unknown = {}) {
  const calls: { url: string; body?: string; auth?: string }[] = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? String(init.body) : undefined, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (u.includes("oauth2.googleapis.com")) return Promise.resolve(new Response(JSON.stringify({ access_token: "ya29.fake", expires_in: 3600 }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify(sendBody), { status: sendStatus }));
  }) as typeof fetch;
  return { fetcher, calls };
}

Deno.test("sendFcm: exchanges the key once, then sends with the bearer token", async () => {
  resetTokenCache();
  const { account } = await testAccount();
  const { fetcher, calls } = fakeGoogle(200);
  const payload = { title: "T", body: "B", url: "/x", tag: "t" };
  assertEquals(await sendFcm(account, "tok1", payload, fetcher), "sent");
  assertEquals(await sendFcm(account, "tok2", payload, fetcher), "sent");
  assertEquals(calls.filter((c) => c.url.includes("oauth2")).length, 1, "the access token is reused");
  const sends = calls.filter((c) => c.url.includes("messages:send"));
  assertEquals(sends.length, 2);
  assertEquals(sends[0].url, "https://fcm.googleapis.com/v1/projects/test-project/messages:send");
  assertEquals(sends[0].auth, "Bearer ya29.fake");
});

Deno.test("sendFcm: a dead token is reported as gone, other errors as failed", async () => {
  resetTokenCache();
  const { account } = await testAccount();
  const payload = { title: "T", body: "B", url: "/x", tag: "t" };
  assertEquals(await sendFcm(account, "t", payload, fakeGoogle(404, { error: { status: "NOT_FOUND" } }).fetcher), "gone");
  resetTokenCache();
  assertEquals(await sendFcm(account, "t", payload, fakeGoogle(500).fetcher), "failed");
});

Deno.test("sendFcm: a failed key exchange is a failure, never a thrown error", async () => {
  resetTokenCache();
  const { account } = await testAccount();
  const failing = (() => Promise.resolve(new Response("no", { status: 401 }))) as typeof fetch;
  assertEquals(await sendFcm(account, "t", { title: "T", body: "B", url: "/x", tag: "t" }, failing), "failed");
  await getAccessToken(account, fakeGoogle(200).fetcher).then((t) => assertEquals(t, "ya29.fake"));
});
