import type { SupabaseClient } from "@supabase/supabase-js";
import { compressAvatar } from "./image-resize";

export const PRIVATE_BUCKET = "family-village-private";

export async function uploadPrivateFile(supabase: SupabaseClient, folder: string, file: File): Promise<{ path: string } | { error: string }> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${folder}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { upsert: false });
  if (error) return { error: error.message };
  return { path };
}

/**
 * Profile and child photos are small, low-sensitivity, and shown on nearly every
 * screen, so their links are signed for a day and remembered on the device. A
 * link that is the same on every visit lets the browser reuse the image it
 * already has; a freshly signed link looks like a new file each time and was
 * downloaded again on every page.
 */
const AVATAR_PREFIX = "avatars/";
const AVATAR_TTL_SECONDS = 24 * 3600;
const AVATAR_REUSE_MARGIN_MS = 2 * 3600 * 1000;
const AVATAR_CACHE_KEY = "vv-avatar-url:";

function readAvatarCache(path: string): string | null {
  try {
    const raw = window.localStorage.getItem(AVATAR_CACHE_KEY + path);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { url: string; exp: number };
    return entry.exp - Date.now() > AVATAR_REUSE_MARGIN_MS ? entry.url : null;
  } catch { return null; }
}

function writeAvatarCache(path: string, url: string) {
  try { window.localStorage.setItem(AVATAR_CACHE_KEY + path, JSON.stringify({ url, exp: Date.now() + AVATAR_TTL_SECONDS * 1000 })); } catch { /* storage unavailable: the link just isn't reused */ }
}

/** Forgets remembered photo links; called on sign-out so the next person on a shared phone starts clean. */
export function clearAvatarUrlCache() {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(AVATAR_CACHE_KEY)) window.localStorage.removeItem(key);
  } catch { /* nothing to clear */ }
}

/** Compresses a photo and stores it for a profile or child; the file is named once and cached by the browser for a year. */
export async function storeAvatar(supabase: SupabaseClient, file: File): Promise<{ path: string } | { error: string }> {
  let prepared: File;
  try { prepared = await compressAvatar(file); } catch (error) { return { error: error instanceof Error ? error.message : "That photo could not be prepared." }; }
  const path = `${AVATAR_PREFIX}${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, prepared, { upsert: false, contentType: "image/jpeg", cacheControl: "31536000" });
  if (error) return { error: error.message };
  return { path };
}

export async function getSignedFileUrl(supabase: SupabaseClient, path: string, expiresInSeconds = 3600): Promise<string | null> {
  if (path.startsWith(AVATAR_PREFIX)) return (await getSignedFileUrls(supabase, [path])).get(path) ?? null;
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Signed URLs for a whole list of files in one call, keyed by path.
 *
 * A roster or a family list can carry a dozen photos at once; asking for each
 * one separately means a dozen round trips before anything paints. Paths that
 * fail (or weren't asked for) are simply absent from the map, so a caller
 * falls back to initials rather than showing a broken image. Avatars are served
 * from the device's remembered links where they are still good.
 */
export async function getSignedFileUrls(supabase: SupabaseClient, paths: string[], expiresInSeconds = 3600): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  if (!unique.length) return new Map();
  const result = new Map<string, string>();

  const avatars = unique.filter((path) => path.startsWith(AVATAR_PREFIX));
  const others = unique.filter((path) => !path.startsWith(AVATAR_PREFIX));
  const stale: string[] = [];
  for (const path of avatars) {
    const cached = readAvatarCache(path);
    if (cached) result.set(path, cached); else stale.push(path);
  }

  const [avatarSigned, otherSigned] = await Promise.all([
    stale.length ? supabase.storage.from(PRIVATE_BUCKET).createSignedUrls(stale, AVATAR_TTL_SECONDS) : Promise.resolve(null),
    others.length ? supabase.storage.from(PRIVATE_BUCKET).createSignedUrls(others, expiresInSeconds) : Promise.resolve(null),
  ]);
  for (const row of avatarSigned?.data ?? []) {
    if (row.signedUrl && !row.error && row.path) { result.set(row.path, row.signedUrl); writeAvatarCache(row.path, row.signedUrl); }
  }
  for (const row of otherSigned?.data ?? []) {
    if (row.signedUrl && !row.error && row.path) result.set(row.path, row.signedUrl);
  }
  return result;
}
