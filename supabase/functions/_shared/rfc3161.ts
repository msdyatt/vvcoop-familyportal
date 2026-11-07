/**
 * RFC 3161 trusted timestamps, with just enough DER to ask for one and read the
 * answer. No dependencies.
 *
 * What a token proves: a time-stamping authority, independent of the co-op,
 * saw this SHA-256 value at the time it names. Anyone can check that offline
 * with `openssl ts -verify` against the authority's certificate chain. It does
 * not prove who signed, and it is not a certificate signature inside the PDF.
 *
 * What this module checks on the way back: the request was granted, the hash in
 * the token is the hash we sent, and the nonce is the one we chose, so a token
 * cannot be swapped in from another request or replayed. It does NOT verify the
 * authority's signature or certificate chain; that needs a trust store, and is
 * what the OpenSSL command in docs/esign-timestamp-verification.md does.
 */

export const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

const SHA256_ALGORITHM_ID = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00]);
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

export type TimestampResult = {
  /** The whole TimeStampResp, as `openssl ts -verify -in` expects it. */
  response: Uint8Array;
  genTime: string;
  serial: string;
  policy: string;
  digestAlgorithm: string;
  imprintHex: string;
};

// --- DER ---------------------------------------------------------------------------------

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  if (n < 0x10000) return [0x82, n >> 8, n & 0xff];
  return [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const header = [tag, ...encodeLength(size)];
  const out = new Uint8Array(header.length + size);
  out.set(header, 0);
  let at = header.length;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) throw new Error("Not a hex string.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** An INTEGER in minimal DER: top bit clear (or it reads as negative) and no leading zero byte. */
function normalizeNonce(nonce: Uint8Array): Uint8Array {
  const n = nonce.slice();
  n[0] = (n[0] & 0x7f) | 0x01;
  return n;
}

/** A TimeStampReq for a SHA-256 value, asking the authority to include its certificate. */
export function buildTimestampRequest(sha256Hex: string, nonce: Uint8Array): Uint8Array {
  const hash = hexToBytes(sha256Hex);
  if (hash.length !== 32) throw new Error("A SHA-256 value is 32 bytes.");
  const n = normalizeNonce(nonce);
  return tlv(0x30,
    tlv(0x02, new Uint8Array([1])),                                  // version 1
    tlv(0x30, SHA256_ALGORITHM_ID, tlv(0x04, hash)),                 // messageImprint
    tlv(0x02, n),                                                    // nonce
    tlv(0x01, new Uint8Array([0xff])),                               // certReq TRUE
  );
}

type Node = { tag: number; start: number; valueStart: number; end: number };

function read(bytes: Uint8Array, at: number, limit = bytes.length): Node {
  if (at + 2 > limit) throw new Error("The timestamp reply is cut short.");
  const tag = bytes[at];
  let len = bytes[at + 1];
  let valueStart = at + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count < 1 || count > 4 || valueStart + count > limit) throw new Error("The timestamp reply has an unreadable length.");
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + bytes[valueStart + i];
    valueStart += count;
  }
  const end = valueStart + len;
  if (end > limit) throw new Error("The timestamp reply is cut short.");
  return { tag, start: at, valueStart, end };
}

function children(bytes: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  let at = node.valueStart;
  while (at < node.end) {
    const child = read(bytes, at, node.end);
    out.push(child);
    at = child.end;
  }
  return out;
}

function oid(bytes: Uint8Array, node: Node): string {
  if (node.tag !== 0x06) throw new Error("Expected an object identifier.");
  const v = bytes.subarray(node.valueStart, node.end);
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join(".");
}

function integerHex(bytes: Uint8Array, node: Node): string {
  let v = bytes.subarray(node.valueStart, node.end);
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return bytesToHex(v);
}

function generalizedTime(bytes: Uint8Array, node: Node): string {
  const text = new TextDecoder().decode(bytes.subarray(node.valueStart, node.end));
  const m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  if (!m) throw new Error("The timestamp has a time in a format we do not read.");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7].slice(0, 4) : ""}Z`;
}

/**
 * Reads a TimeStampResp and checks it answers *this* request. Throws, with a
 * sentence an administrator can act on, if it does not.
 */
export function parseTimestampResponse(response: Uint8Array, expectedSha256Hex: string, expectedNonce: Uint8Array): TimestampResult {
  const top = read(response, 0);
  if (top.tag !== 0x30) throw new Error("The timestamp reply is not in the expected format.");
  const [statusInfo, token] = children(response, top);
  if (!statusInfo || statusInfo.tag !== 0x30) throw new Error("The timestamp reply is not in the expected format.");
  const status = Number(integerHex(response, children(response, statusInfo)[0]) || "0");
  // 0 = granted, 1 = granted with modifications. Anything else is a refusal.
  if (status !== 0 && status !== 1) throw new Error(`The time-stamping authority refused the request (status ${status}).`);
  if (!token || token.tag !== 0x30) throw new Error("The time-stamping authority answered without a timestamp.");

  // ContentInfo { signedData, [0] SignedData { version, digestAlgorithms, encapContentInfo { tstInfo, [0] OCTET STRING } ... } }
  const [contentType, content] = children(response, token);
  if (oid(response, contentType) !== OID_SIGNED_DATA) throw new Error("The timestamp is not a signed-data token.");
  const signedData = children(response, content)[0];
  const encap = children(response, signedData)[2];
  const [encapType, encapContent] = children(response, encap);
  if (oid(response, encapType) !== OID_TST_INFO) throw new Error("The timestamp token does not carry timestamp information.");
  const octets = children(response, encapContent)[0];
  const tstInfoBytes = response.subarray(octets.valueStart, octets.end);
  const tst = read(tstInfoBytes, 0);
  const parts = children(tstInfoBytes, tst);
  // version, policy, messageImprint, serialNumber, genTime, [accuracy], [ordering], [nonce], ...
  const policy = oid(tstInfoBytes, parts[1]);
  const imprint = children(tstInfoBytes, parts[2]);
  const algorithm = oid(tstInfoBytes, children(tstInfoBytes, imprint[0])[0]);
  const imprintHex = bytesToHex(tstInfoBytes.subarray(imprint[1].valueStart, imprint[1].end));
  const serial = integerHex(tstInfoBytes, parts[3]);
  const genTime = generalizedTime(tstInfoBytes, parts[4]);
  let nonceHex: string | null = null;
  for (const p of parts.slice(5)) if (p.tag === 0x02) nonceHex = integerHex(tstInfoBytes, p);

  if (algorithm !== OID_SHA256) throw new Error("The timestamp was made with a different hash algorithm than we asked for.");
  if (imprintHex !== expectedSha256Hex.toLowerCase()) throw new Error("The timestamp is for a different document than the one we sent.");
  const expectedNonceHex = bytesToHex(normalizeNonce(expectedNonce));
  if (nonceHex === null || nonceHex !== expectedNonceHex) throw new Error("The timestamp does not answer this request (the nonce differs).");

  return { response, genTime, serial, policy, digestAlgorithm: "SHA-256", imprintHex };
}

/**
 * Asks a time-stamping authority for a token over a SHA-256 value. Retries a
 * couple of times on network trouble; a refusal or a mismatched answer is not
 * retried because asking again will not change it.
 */
export async function requestTimestamp(
  url: string,
  sha256Hex: string,
  options: { fetchFn?: typeof fetch; attempts?: number; delayMs?: number } = {},
): Promise<TimestampResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const attempts = options.attempts ?? 3;
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const body = buildTimestampRequest(sha256Hex, nonce);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query", "Accept": "application/timestamp-reply" },
        body: body as BodyInit,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new TransientError(`The time-stamping authority answered ${res.status}.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return parseTimestampResponse(bytes, sha256Hex, nonce);
    } catch (error) {
      lastError = error;
      const transient = error instanceof TransientError || error instanceof TypeError || (error instanceof DOMException);
      if (!transient || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, (options.delayMs ?? 1000) * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

class TransientError extends Error {}

// Exposed for tests that build a fake authority's reply.
export const der = { tlv, encodeLength };
export const OIDS = { OID_SIGNED_DATA, OID_TST_INFO, OID_SHA256 };
