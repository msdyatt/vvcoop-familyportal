/**
 * OpenSign wire contract.
 *
 * Everything that depends on OpenSign's exact request and response shape lives
 * in this one file, so correcting the contract is a single-file change.
 *
 * Verified against a real sandbox send on 22 August 2026 -- a minimal PDF POSTed
 * to https://sandbox.opensignlabs.com/api/v1.2/createdocument returned 200 with
 * a real objectId and signurl. This is no longer guesswork.
 *
 *   - Auth: `x-api-token: <token>` request header.
 *   - API version is **v1.2**. Base URLs:
 *       production   https://app.opensignlabs.com/api/v1.2
 *       sandbox      https://sandbox.opensignlabs.com/api/v1.2
 *       EU region    https://eu-app.opensignlabs.com/api/v1.2
 *     Read from public.integration_settings.api_base_url, never hardcoded, so
 *     cloud, EU and self-hosted all work without a code change.
 *   - POST /createdocument returns
 *       { objectId, signurl: [...], message: "Document sent successfully!" }
 *
 * Note on widgets: every signer needs at least one widget, or the document
 * arrives with nowhere to sign. See defaultSignatureWidget below.
 */
export type OpenSignWidget = {
  type: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type OpenSignSigner = {
  email: string;
  name?: string;
  role?: string;
  widgets?: OpenSignWidget[];
};

/**
 * Where the signature box lands when the caller doesn't specify one.
 *
 * Page 1, lower left -- the conventional spot on the co-op's one- and two-page
 * waivers and permission forms. A longer document will want the box on its last
 * page instead; pass explicit widgets to override rather than editing this.
 */
export function defaultSignatureWidget(): OpenSignWidget {
  return { type: "signature", page: 1, x: 30, y: 40, w: 80, h: 30 };
}

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
  note?: string;
  description?: string;
  timeToCompleteDays?: number;
  /** Set false to create the document without emailing signers (useful in sandbox). */
  sendEmail?: boolean;
}): Promise<SendResult> {
  const body = {
    file: opts.fileBase64,
    title: opts.title,
    note: opts.note ?? `Please sign "${opts.title}" for Veritas Village.`,
    description: opts.description ?? "",
    timeToCompleteDays: opts.timeToCompleteDays ?? 15,
    signers: opts.signers.map((signer) => ({
      role: signer.role ?? "Signer",
      email: signer.email,
      name: signer.name ?? signer.email,
      // A signer with no widget gets a document with nowhere to sign.
      widgets: signer.widgets?.length ? signer.widgets : [defaultSignatureWidget()],
    })),
    send_email: opts.sendEmail ?? true,
    sendInOrder: opts.sendInOrder ?? false,
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
      "OpenSign accepted the document but returned no objectId. Check the " +
      "response shape and update extractDocumentId in " +
      "supabase/functions/_shared/opensign.ts.",
      200,
      result,
    );
  }

  return { providerDocumentId, signingUrls: extractSigningUrls(result, opts.signers), raw: result };
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

/**
 * Reads the `signurl` array back into a per-signer map.
 *
 * The confirmed response carries `signurl` as an array. Its element shape is not
 * pinned down, so both forms are handled: objects carrying an email alongside a
 * url, and bare url strings, which are matched to signers positionally in the
 * order they were submitted.
 */
function extractSigningUrls(payload: unknown, signers: OpenSignSigner[]): Record<string, string> {
  const urls: Record<string, string> = {};
  if (!payload || typeof payload !== "object") return urls;
  const record = payload as Record<string, unknown>;
  const list = record.signurl ?? record.signers ?? record.signingLinks;
  if (!Array.isArray(list)) return urls;

  list.forEach((entry, index) => {
    if (typeof entry === "string" && entry) {
      const signer = signers[index];
      if (signer) urls[signer.email] = entry;
      return;
    }
    if (entry && typeof entry === "object") {
      const item = entry as Record<string, unknown>;
      const url = ["signurl", "signingUrl", "url"]
        .map((key) => item[key])
        .find((value): value is string => typeof value === "string" && !!value);
      if (!url) return;
      const email = typeof item.email === "string" ? item.email : signers[index]?.email;
      if (email) urls[email] = url;
    }
  });
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
