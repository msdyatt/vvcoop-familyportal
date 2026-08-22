/**
 * OpenSign wire contract.
 *
 * Everything that depends on OpenSign's exact request and response shape lives
 * in this one file, so correcting the contract is a single-file change.
 *
 * What is confirmed:
 *   - Auth is an `x-api-token` request header (OpenSign API v1.1).
 *   - The cloud base URL is https://app.opensignlabs.com/api/v1; self-hosted
 *     instances expose the same paths under their own origin. The base URL is
 *     read from public.integration_settings.api_base_url rather than hardcoded,
 *     so cloud and self-hosted both work.
 *   - The relevant paths are POST /createdocument, GET /document/{id} and the
 *     webhook configuration endpoints.
 *
 * What is NOT confirmed, and why:
 *   OpenSign's published openapi.json (apps/OpenSignServer/public/openapi.json)
 *   is an unedited Swagger Petstore template -- /createdocument is documented
 *   there as "Returns pet inventories by status" with operationId getInventory
 *   -- and the hosted API reference renders client-side, so the exact field
 *   names of the /createdocument body could not be verified from source.
 *
 *   The body below follows the documented widget/signer vocabulary. Confirm it
 *   against the live reference on a paid account, or against the JSON that
 *   https://app.opensignlabs.com/debugpdf emits, before relying on it. A
 *   mismatch surfaces as a clear OpenSignError with OpenSign's own message
 *   rather than a silent failure -- see sendForSignature.
 */

export type OpenSignSigner = {
  email: string;
  name?: string;
};

export type SendResult = {
  providerDocumentId: string;
  signingUrls: Record<string, string>;
  raw: unknown;
};

export class OpenSignError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
    this.name = "OpenSignError";
  }
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function call(baseUrl: string, token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(joinUrl(baseUrl, path), {
    ...init,
    headers: {
      "x-api-token": token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }

  if (!response.ok) {
    const detail = typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : text.slice(0, 300);
    throw new OpenSignError(detail || `OpenSign returned ${response.status}`, response.status, body);
  }
  return body;
}

/**
 * Sends a PDF for signature and returns the provider's document id.
 *
 * `fileBase64` is the raw PDF without a data: prefix.
 */
export async function sendForSignature(opts: {
  baseUrl: string;
  token: string;
  title: string;
  fileBase64: string;
  signers: OpenSignSigner[];
  sendInOrder?: boolean;
}): Promise<SendResult> {
  const body = {
    title: opts.title,
    file: opts.fileBase64,
    signers: opts.signers.map((signer, index) => ({
      email: signer.email,
      name: signer.name ?? signer.email,
      order: index + 1,
    })),
    sendInOrder: opts.sendInOrder ?? false,
    sendmail: true,
  };

  const result = await call(opts.baseUrl, opts.token, "/createdocument", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const providerDocumentId = extractDocumentId(result);
  if (!providerDocumentId) {
    // The call succeeded but the response did not carry an id we recognise.
    // Surfacing this loudly beats storing an empty id that the webhook can
    // never match against.
    throw new OpenSignError(
      "OpenSign accepted the document but returned no recognisable document id. " +
      "Check the response shape against your account's API reference and update " +
      "extractDocumentId in supabase/functions/_shared/opensign.ts.",
      200,
      result,
    );
  }

  return { providerDocumentId, signingUrls: extractSigningUrls(result), raw: result };
}

/** OpenSign is a Parse-backed app, so an id may arrive under several keys. */
export function extractDocumentId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["objectId", "documentId", "docId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  for (const nest of ["result", "data", "document"]) {
    const inner = record[nest];
    if (inner && typeof inner === "object") {
      const found = extractDocumentId(inner);
      if (found) return found;
    }
  }
  return null;
}

function extractSigningUrls(payload: unknown): Record<string, string> {
  const urls: Record<string, string> = {};
  if (!payload || typeof payload !== "object") return urls;
  const record = payload as Record<string, unknown>;
  const list = record.signers ?? record.signingLinks ?? record.signurl;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        const email = typeof item.email === "string" ? item.email : null;
        const url = ["signurl", "signingUrl", "url"]
          .map((k) => item[k])
          .find((v): v is string => typeof v === "string" && !!v);
        if (email && url) urls[email] = url;
      }
    }
  }
  return urls;
}

/**
 * Maps an OpenSign webhook event or document status onto the vocabulary stored
 * in public.signature_requests.status. Unknown values return null so the
 * webhook can record that it saw something it did not understand rather than
 * guessing at a state.
 */
export function mapStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.includes("declin")) return "declined";
  if (value.includes("expire")) return "expired";
  if (value.includes("complet") || value.includes("signed") || value.includes("finish")) return "signed";
  if (value.includes("view") || value.includes("open")) return "viewed";
  if (value.includes("sent") || value.includes("creat")) return "sent";
  return null;
}
