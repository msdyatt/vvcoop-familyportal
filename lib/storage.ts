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
