/**
 * A small Gmail API and Google OAuth client for the office inbox. It only ever talks to one
 * mailbox (the office one) with the gmail.modify scope: read, label and send. Nothing here can
 * delete mail, and nothing calls a delete or trash endpoint.
 *
 * Every network call goes through the `fetch` passed in, so the tests run with a fake network.
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const IMPORTED_LABEL_NAME = "Portal imported";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Google refused the stored authorisation (revoked, expired, wrong client). Reconnect needed. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** Any other answer from Google that was not a success. */
export class GmailApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "GmailApiError";
  }
}

export type OAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

// --- PKCE and state ---------------------------------------------------------------------------
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** The Google sign-in page address. `loginHint` pre-fills the office mailbox. */
export function buildAuthUrl(config: OAuthConfig, state: string, codeChallenge: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    // Always ask, so Google always returns a refresh token (it omits it on a silent re-grant).
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

type TokenAnswer = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

async function postToken(fetchFn: FetchLike, body: Record<string, string>): Promise<TokenAnswer> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new GmailApiError(`Could not reach Google: ${error instanceof Error ? error.message : String(error)}`, 0, true);
  }
  const answer = await response.json().catch(() => ({})) as TokenAnswer;
  if (response.ok && answer.access_token) return answer;
  // invalid_grant: the refresh token was revoked or expired. invalid_client: wrong id or secret.
  if (answer.error === "invalid_grant" || answer.error === "invalid_client" || answer.error === "unauthorized_client" || response.status === 401) {
    throw new GoogleAuthError(`Google refused the office mailbox authorisation (${answer.error ?? response.status}). Reconnect the office inbox.`);
  }
  throw new GmailApiError(`Google token request failed (${response.status}${answer.error ? `: ${answer.error}` : ""}).`, response.status, response.status >= 500 || response.status === 429);
}

export async function exchangeCode(fetchFn: FetchLike, config: OAuthConfig, code: string, codeVerifier: string) {
  const answer = await postToken(fetchFn, {
    grant_type: "authorization_code", code, code_verifier: codeVerifier,
    client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
  });
  const scopes = (answer.scope ?? "").split(/\s+/);
  if (!scopes.includes(GMAIL_SCOPE)) throw new GoogleAuthError("Google did not grant access to the mailbox. Try again and allow access.");
  return { accessToken: answer.access_token!, refreshToken: answer.refresh_token ?? null };
}

export async function refreshAccessToken(fetchFn: FetchLike, config: Omit<OAuthConfig, "redirectUri">, refreshToken: string): Promise<string> {
  const answer = await postToken(fetchFn, {
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret,
  });
  return answer.access_token!;
}

/** Best effort: tell Google to forget the grant. A failure here does not stop a disconnect. */
export async function revokeToken(fetchFn: FetchLike, token: string): Promise<boolean> {
  try {
    const response = await fetchFn(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// --- Gmail API shapes (only the fields used) ---------------------------------------------------------
export type GmailHeader = { name: string; value: string };
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
};
export type GmailHistoryPage = {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
  historyId?: string;
  nextPageToken?: string;
};
export type GmailLabel = { id: string; name: string; type?: string };

export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gmail for one signed-in mailbox. Retries once on a rate limit or a server error. */
export class GmailClient {
  constructor(private readonly fetchFn: FetchLike, private readonly accessToken: string, private readonly sleep: SleepFn = realSleep) {}

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | string[] | undefined>): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
    }
    const url = `${GMAIL_BASE}${path}${params.size ? `?${params.toString()}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers: { Authorization: `Bearer ${this.accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === 0) { await this.sleep(500); continue; }
        throw new GmailApiError(`Could not reach Gmail: ${error instanceof Error ? error.message : String(error)}`, 0, true);
      }
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return await response.json() as T;
      }
      const text = await response.text().catch(() => "");
      let message = text.slice(0, 300);
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* keep text */ }
      if (response.status === 401) throw new GoogleAuthError("Gmail refused the access token. Reconnect the office inbox.");
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt === 0) { await this.sleep(1000); continue; }
      throw new GmailApiError(`Gmail ${method} ${path.split("?")[0]} failed (${response.status}): ${message}`, response.status, retryable);
    }
  }

  profile() {
    return this.request<{ emailAddress: string; historyId: string }>("GET", "/profile");
  }

  listLabels() {
    return this.request<{ labels?: GmailLabel[] }>("GET", "/labels");
  }

  createLabel(name: string) {
    return this.request<GmailLabel>("POST", "/labels", { name, labelListVisibility: "labelShow", messageListVisibility: "show" });
  }

  /** The id of the "Portal imported" label, made if it is missing. */
  async ensureLabel(name = IMPORTED_LABEL_NAME): Promise<string> {
    const { labels } = await this.listLabels();
    const found = (labels ?? []).find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    try {
      return (await this.createLabel(name)).id;
    } catch (error) {
      // Made by a parallel call in the meantime.
      if (error instanceof GmailApiError && error.status === 409) {
        const again = await this.listLabels();
        const label = (again.labels ?? []).find((l) => l.name.toLowerCase() === name.toLowerCase());
        if (label) return label.id;
      }
      throw error;
    }
  }

  history(startHistoryId: string, pageToken?: string) {
    return this.request<GmailHistoryPage>("GET", "/history", undefined, {
      startHistoryId, historyTypes: "messageAdded", maxResults: "500", pageToken,
    });
  }

  listMessages(q: string, pageToken?: string, maxResults = 100) {
    return this.request<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>("GET", "/messages", undefined, {
      q, pageToken, maxResults: String(maxResults),
    });
  }

  getMessage(id: string) {
    return this.request<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, undefined, { format: "full" });
  }

  getMessageId(id: string) {
    return this.request<GmailMessage>("GET", `/messages/${encodeURIComponent(id)}`, undefined, { format: "metadata", metadataHeaders: ["Message-ID"] });
  }

  getAttachment(messageId: string, attachmentId: string) {
    return this.request<{ size?: number; data?: string }>("GET", `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  /** Adds labels only. Never removes INBOX or UNREAD, and never trashes. */
  addLabels(ids: string[], labelId: string) {
    if (ids.length === 0) return Promise.resolve(undefined);
    return this.request<void>("POST", "/messages/batchModify", { ids: ids.slice(0, 1000), addLabelIds: [labelId] });
  }

  send(raw: string, threadId: string | null) {
    return this.request<{ id: string; threadId: string; labelIds?: string[] }>("POST", "/messages/send", threadId ? { raw, threadId } : { raw });
  }
}
