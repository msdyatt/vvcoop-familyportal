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
 *   - POST /createdocument/:template_id sends an existing template. Documented
 *     v1.2 contract: body takes title, signers[], send_email, sendInOrder,
 *     timeToCompleteDays. Preferred over uploading a PDF, because the template
 *     already has its signature fields positioned -- uploading instead means
 *     guessing, and a page-1 guess is wrong on a ten-page handbook.
 *   - GET /document/:id returns { status, file, certificate, signers, ... },
 *     which is what makes tracking possible without a webhook.
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
  // GET /document/:id reports "in-progress" for a document that is out but
  // unsigned. Without this it fell through to null and read as unrecognised.
  if (value.includes("sent") || value.includes("creat") || value.includes("progress") || value.includes("pending")) return "sent";
  return null;
}


/** What a poll of GET /document/:id tells us. */
export type DocumentState = {
  status: string | null;
  /** Signed PDF, once the document is complete. */
  fileUrl: string | null;
  /** Completion certificate, once the document is complete. */
  certificateUrl: string | null;
  signers: { email: string | null; status: string | null }[];
  raw: unknown;
};

/**
 * Sends an existing OpenSign template to one signer.
 *
 * The signature fields come from the template, so nothing here places widgets.
 * `role` should match a role defined on the template; OpenSign falls back to
 * its own default when it does not.
 */
export async function sendFromTemplate(opts: {
  baseUrl: string;
  token: string;
  templateId: string;
  title?: string;
  signers: OpenSignSigner[];
  sendEmail?: boolean;
  sendInOrder?: boolean;
  timeToCompleteDays?: number;
}): Promise<SendResult> {
  const body: Record<string, unknown> = {
    signers: opts.signers.map((signer) => ({
      role: signer.role ?? "Signer",
      email: signer.email,
      name: signer.name ?? signer.email,
    })),
    send_email: opts.sendEmail ?? true,
    sendInOrder: opts.sendInOrder ?? false,
    timeToCompleteDays: opts.timeToCompleteDays ?? 15,
  };
  if (opts.title) body.title = opts.title;

  const result = await call(opts.baseUrl, opts.token, `/createdocument/${encodeURIComponent(opts.templateId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  const providerDocumentId = extractDocumentId(result);
  if (!providerDocumentId) {
    throw new OpenSignError(
      "OpenSign accepted the template send but returned no objectId, so the signature could never be matched back to a family.",
      200, result,
    );
  }
  return { providerDocumentId, signingUrls: extractSigningUrls(result, opts.signers), raw: result };
}

/** Reads back the current state of a document we previously sent. */
export async function getDocumentState(baseUrl: string, token: string, documentId: string): Promise<DocumentState> {
  const result = await call(baseUrl, token, `/document/${encodeURIComponent(documentId)}`, { method: "GET" });
  const record = (result ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" && record[key] ? record[key] as string : null);

  const signers = Array.isArray(record.signers)
    ? (record.signers as Record<string, unknown>[]).map((signer) => ({
        email: typeof signer.email === "string" ? signer.email : null,
        status: typeof signer.status === "string" ? signer.status
          : typeof signer.signed === "boolean" ? (signer.signed ? "signed" : "pending")
          : null,
      }))
    : [];

  return {
    status: str("status"),
    fileUrl: str("file"),
    certificateUrl: str("certificate"),
    signers,
    raw: result,
  };
}

/**
 * Answers one question: does OpenSign accept our API token?
 *
 * There is no dedicated whoami endpoint in v1.2, so this posts an empty body to
 * /createdocument. Nothing is created -- an empty body cannot be -- but the two
 * failures are distinguishable, and that distinction is the whole point:
 *
 *   bad token   405 {"error":"Invalid API Token!"}
 *   good token  400 {"error":"Please provide all required parameters."}
 *
 * Both were confirmed against the live and sandbox hosts on 22 August 2026.
 * Without this, a rotated token looks exactly like "no signatures yet", which is
 * how this integration sat broken without anyone being able to tell.
 */
export async function checkCredentials(baseUrl: string, token: string): Promise<{ ok: boolean; detail: string }> {
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, "/createdocument"), {
      method: "POST",
      headers: { "x-api-token": token, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    return { ok: false, detail: `OpenSign could not be reached at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const text = await response.text();
  let message = text.slice(0, 200);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const found = parsed.error ?? parsed.message;
    if (typeof found === "string") message = found;
  } catch { /* keep the raw text */ }

  // Anything mentioning the token is an auth failure; anything else means the
  // request got past auth and into validation, which is what we wanted to know.
  if (/api\s*token/i.test(message)) {
    return { ok: false, detail: `OpenSign rejected the API token (${response.status}: ${message}). Generate a new token in OpenSign under Settings → API Token and set it as the OPENSIGN_API_TOKEN secret.` };
  }
  if (/not\s*found|cannot\s+post/i.test(message) || response.status === 404) {
    return { ok: false, detail: `No OpenSign API at ${baseUrl} (${response.status}). Check the base URL ends in /api/v1.2.` };
  }
  return { ok: true, detail: `OpenSign accepted the API token at ${baseUrl}.` };
}
