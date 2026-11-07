/// <reference lib="deno.ns" />
import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { buildTimestampRequest, bytesToHex, der, hexToBytes, OIDS, parseTimestampResponse, requestTimestamp } from "./rfc3161.ts";

const HASH = "f0b645062cbb5750fab0ebc0bb56475cfa311e27597d6831f5f43fd538fead43";

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...chunk);
  }
  return der.tlv(0x06, new Uint8Array(out));
}
const int = (hex: string) => der.tlv(0x02, hexToBytes(hex));

/** Pulls the nonce back out of a request we built, as a fake authority would. */
function nonceOf(request: Uint8Array): Uint8Array {
  // 30 len | 02 01 01 | 30 2f ... | 02 08 <nonce> | 01 01 ff
  const at = request.length - 3 - 8;
  return request.slice(at, at + 8);
}

/** A reply shaped like a real authority's, with the fields tests want to vary. */
function fakeReply(o: { imprintHex?: string; nonce: Uint8Array; status?: number; algorithm?: string; genTime?: string; withToken?: boolean }): Uint8Array {
  const status = der.tlv(0x30, int((o.status ?? 0).toString(16).padStart(2, "0")));
  if (o.withToken === false) return der.tlv(0x30, status);
  const algId = der.tlv(0x30, oid(o.algorithm ?? OIDS.OID_SHA256), der.tlv(0x05));
  const tst = der.tlv(0x30,
    int("01"), oid("2.16.840.1.114412.7.1"),
    der.tlv(0x30, algId, der.tlv(0x04, hexToBytes(o.imprintHex ?? HASH))),
    int("00abcdef0123456789"),
    der.tlv(0x18, new TextEncoder().encode(o.genTime ?? "20261106230250Z")),
    int(bytesToHex(o.nonce)),
  );
  const encap = der.tlv(0x30, oid(OIDS.OID_TST_INFO), der.tlv(0xa0, der.tlv(0x04, tst)));
  const signedData = der.tlv(0x30, int("03"), der.tlv(0x31), encap);
  const contentInfo = der.tlv(0x30, oid(OIDS.OID_SIGNED_DATA), der.tlv(0xa0, signedData));
  return der.tlv(0x30, status, contentInfo);
}

Deno.test("request: version 1, a sha-256 imprint, a positive nonce, and the certificate asked for", () => {
  const nonce = new Uint8Array([0xff, 1, 2, 3, 4, 5, 6, 7]);
  const req = buildTimestampRequest(HASH, nonce);
  assertEquals(req[0], 0x30);
  assertEquals([...req.slice(2, 5)], [0x02, 0x01, 0x01]);
  // sha-256 AlgorithmIdentifier then the 32 hash bytes
  assertStringIncludes(bytesToHex(req), "300d06096086480165030402010500" + "0420" + HASH);
  // nonce: INTEGER, 8 bytes, top bit clear
  assertEquals([...req.slice(-13, -11)], [0x02, 0x08]);
  assertEquals(req[req.length - 11] & 0x80, 0);
  // certReq TRUE
  assertEquals([...req.slice(-3)], [0x01, 0x01, 0xff]);
  // The DER length covers everything after the header.
  assertEquals(req[1], req.length - 2);
});

Deno.test("request: refuses a hash that is not 32 bytes", () => {
  try { buildTimestampRequest("abcd", new Uint8Array(8)); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "32 bytes"); }
});

Deno.test("parse: reads time, serial, policy and imprint from a granted reply", () => {
  const nonce = new Uint8Array([0x3b, 0xab, 0x27, 0x2b, 0x36, 0xeb, 0x0c, 0x3c]);
  const req = buildTimestampRequest(HASH, nonce);
  const reply = fakeReply({ nonce: nonceOf(req) });
  const out = parseTimestampResponse(reply, HASH, nonce);
  assertEquals(out.genTime, "2026-11-06T23:02:50Z");
  assertEquals(out.serial, "abcdef0123456789");
  assertEquals(out.policy, "2.16.840.1.114412.7.1");
  assertEquals(out.imprintHex, HASH);
  assertEquals(out.digestAlgorithm, "SHA-256");
  assertEquals(out.response, reply);
});

Deno.test("parse: a token for a different document is refused", () => {
  const nonce = new Uint8Array(8).fill(9);
  const reply = fakeReply({ nonce: nonceOf(buildTimestampRequest(HASH, nonce)), imprintHex: "00".repeat(32) });
  try { parseTimestampResponse(reply, HASH, nonce); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "different document"); }
});

Deno.test("parse: a token with someone else's nonce is refused", () => {
  const reply = fakeReply({ nonce: new Uint8Array(8).fill(5) });
  try { parseTimestampResponse(reply, HASH, new Uint8Array(8).fill(9)); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "nonce"); }
});

Deno.test("parse: a refusal and a reply with no token are reported plainly", () => {
  const nonce = new Uint8Array(8).fill(9);
  try { parseTimestampResponse(fakeReply({ nonce, status: 2, withToken: false }), HASH, nonce); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "refused"); }
  try { parseTimestampResponse(fakeReply({ nonce, withToken: false }), HASH, nonce); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "without a timestamp"); }
});

Deno.test("parse: another hash algorithm is refused, and garbage does not crash", () => {
  const nonce = new Uint8Array(8).fill(9);
  const sha1 = fakeReply({ nonce: nonceOf(buildTimestampRequest(HASH, nonce)), algorithm: "1.3.14.3.2.26" });
  try { parseTimestampResponse(sha1, HASH, nonce); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "different hash algorithm"); }
  try { parseTimestampResponse(new Uint8Array([1, 2, 3]), HASH, nonce); throw new Error("did not throw"); } catch (e) { assertStringIncludes(String(e), "timestamp reply"); }
});

Deno.test("requestTimestamp: posts the query, checks the answer, and returns it", async () => {
  let seen: { url: string; type: string | null; bodyLength: number } | null = null;
  const fetchFn = ((url: string, init: RequestInit) => {
    const body = init.body as Uint8Array;
    seen = { url, type: new Headers(init.headers).get("content-type"), bodyLength: body.length };
    return Promise.resolve(new Response(fakeReply({ nonce: nonceOf(body) }) as BodyInit));
  }) as unknown as typeof fetch;
  const out = await requestTimestamp("https://tsa.example.test/ts", HASH, { fetchFn });
  assertEquals(seen!.url, "https://tsa.example.test/ts");
  assertEquals(seen!.type, "application/timestamp-query");
  assertEquals(out.imprintHex, HASH);
});

Deno.test("requestTimestamp: retries network trouble, but not a mismatched answer", async () => {
  let calls = 0;
  const flaky = ((_u: string, init: RequestInit) => {
    calls += 1;
    if (calls < 3) return Promise.reject(new TypeError("network down"));
    return Promise.resolve(new Response(fakeReply({ nonce: nonceOf(init.body as Uint8Array) }) as BodyInit));
  }) as unknown as typeof fetch;
  await requestTimestamp("https://tsa.example.test", HASH, { fetchFn: flaky, delayMs: 1 });
  assertEquals(calls, 3);

  let mismatchCalls = 0;
  const wrong = (() => { mismatchCalls += 1; return Promise.resolve(new Response(fakeReply({ nonce: new Uint8Array(8).fill(1) }) as BodyInit)); }) as unknown as typeof fetch;
  await assertRejects(() => requestTimestamp("https://tsa.example.test", HASH, { fetchFn: wrong, delayMs: 1 }), Error, "nonce");
  assertEquals(mismatchCalls, 1);

  let serverErrors = 0;
  const down = (() => { serverErrors += 1; return Promise.resolve(new Response("busy", { status: 503 })); }) as unknown as typeof fetch;
  await assertRejects(() => requestTimestamp("https://tsa.example.test", HASH, { fetchFn: down, delayMs: 1 }), Error, "503");
  assertEquals(serverErrors, 3);
});
