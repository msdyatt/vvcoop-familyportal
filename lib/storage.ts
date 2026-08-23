import type { SupabaseClient } from "@supabase/supabase-js";

export const PRIVATE_BUCKET = "family-village-private";

export async function uploadPrivateFile(supabase: SupabaseClient, folder: string, file: File): Promise<{ path: string } | { error: string }> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${folder}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(path, file, { upsert: false });
  if (error) return { error: error.message };
  return { path };
}

export async function getSignedFileUrl(supabase: SupabaseClient, path: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Signed URLs for a whole list of avatars in one call, keyed by path.
 *
 * A roster or a family list can carry a dozen photos at once; asking for each
 * one separately means a dozen round trips before anything paints. Paths that
 * fail (or weren't asked for) are simply absent from the map, so a caller
 * falls back to initials rather than showing a broken image.
 */
export async function getSignedFileUrls(supabase: SupabaseClient, paths: string[], expiresInSeconds = 3600): Promise<Map<string, string>> {
  const unique = [...new Set(paths)];
  if (!unique.length) return new Map();
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrls(unique, expiresInSeconds);
  if (error || !data) return new Map();
  const entries: [string, string][] = [];
  for (const row of data) {
    if (row.signedUrl && !row.error && row.path) entries.push([row.path, row.signedUrl]);
  }
  return new Map(entries);
}
