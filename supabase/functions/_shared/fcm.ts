/**
 * Firebase Cloud Messaging (HTTP v1) for the iOS and Android apps. Written
 * against fetch and WebCrypto only, so it runs in the edge runtime and can be
 * tested with a throwaway key.
 *
 * The Firebase service-account key lives in Supabase Vault as
 * FCM_SERVICE_ACCOUNT (the JSON file Firebase gives you, as one string).
 */

export type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };
export type PushPayload = { title: string; body: string; url: string; tag: string };
export type FcmResult = "sent" | "gone" | "failed";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (input: ArrayBuffer | string): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

/** The signed JWT Google exchanges for a short-lived access token. */
export async function createServiceJwt(account: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email, scope: SCOPE,
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: nowSeconds, exp: nowSeconds + 3600,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

let cached: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(account: ServiceAccount, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const assertion = await createServiceJwt(account, Math.floor(now / 1000));
  const response = await fetcher(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  const data = await response.json() as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return data.access_token;
}

export function resetTokenCache() { cached = null; }

/** One FCM message. `url` and `tag` ride in `data`; the app routes the tap from it. */
export function buildFcmMessage(deviceToken: string, payload: PushPayload) {
  return {
    message: {
      token: deviceToken,
      notification: { title: payload.title, body: payload.body },
      data: { url: payload.url, tag: payload.tag },
      android: { priority: "HIGH", notification: { tag: payload.tag } },
      apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
    },
  };
}

/** Whether FCM's answer means this device token is dead for good and should be deleted. */
export function isDeadToken(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const text = JSON.stringify(body ?? "");
  return /UNREGISTERED|registration token is not a valid|Requested entity was not found/i.test(text);
}

export async function sendFcm(account: ServiceAccount, deviceToken: string, payload: PushPayload, fetcher: typeof fetch = fetch): Promise<FcmResult> {
  try {
    const accessToken = await getAccessToken(account, fetcher);
    const response = await fetcher(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildFcmMessage(deviceToken, payload)),
    });
    if (response.ok) return "sent";
    const body = await response.json().catch(() => null);
    if (response.status === 401) resetTokenCache();
    return isDeadToken(response.status, body) ? "gone" : "failed";
  } catch {
    return "failed";
  }
}
