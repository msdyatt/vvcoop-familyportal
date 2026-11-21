import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The records vault (supabase/migrations/20261114110000_records_vault.sql), browser side.
 *
 * The database does the deciding: who may read or change a record, that a file is never overwritten, that every
 * open is logged, that erasing needs an archived record past its retention date. These helpers only shape what is
 * sent and explain what comes back, so the screen can say no before a round trip and the words match the database's.
 */

export const RECORDS_BUCKET = "family-village-private";

export const RECORD_CATEGORIES = [
  { id: "insurance", label: "Insurance" },
  { id: "lease", label: "Lease" },
  { id: "nonprofit", label: "Nonprofit" },
  { id: "tax", label: "Tax" },
  { id: "financial", label: "Financial" },
  { id: "contract", label: "Contract" },
  { id: "license", label: "License or permit" },
  { id: "other", label: "Other" },
] as const;

export type RecordCategory = (typeof RECORD_CATEGORIES)[number]["id"];

export function categoryLabel(id: string): string {
  return RECORD_CATEGORIES.find((row) => row.id === id)?.label ?? id;
}

/** The database marks these sensitive when nobody says otherwise (admin_create_record). */
export function sensitiveByDefault(category: string): boolean {
  return category === "nonprofit" || category === "tax" || category === "financial";
}

export const RECORD_FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export const RECORD_FILE_ACCEPT = Object.keys(RECORD_FILE_TYPES).join(",");
export const RECORD_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Why this file cannot go in the vault, or null if it can. */
export function recordFileProblem(file: { type: string; size: number }): string | null {
  if (!RECORD_FILE_TYPES[file.type]) return "Only a PDF or a photo (JPG, PNG, WebP) can be kept here.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > RECORD_FILE_MAX_BYTES) return "That file is larger than 20 MB.";
  return null;
}

/** records/<record>/<file>.<ext>: the only shape the storage policy and admin_add_record_file accept. */
export function recordFilePath(recordId: string, fileId: string, contentType: string): string {
  const ext = RECORD_FILE_TYPES[contentType];
  if (!ext) throw new Error("Only a PDF or a photo (JPG, PNG, WebP) can be kept here.");
  return `records/${recordId}/${fileId}.${ext}`;
}

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "Fire, Liability , fire" -> ["fire", "liability"], the same tidying as private.clean_record_tags. */
export function parseTags(text: string): string[] {
  const tags = new Set<string>();
  for (const part of text.split(",")) {
    const tag = part.trim().toLowerCase().slice(0, 40);
    if (tag) tags.add(tag);
  }
  return [...tags].sort();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

/** 2027-03-01 -> "March 1, 2027", pinned to UTC so a date never shows a day early. */
export function longDate(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export type ExpiryState = { tone: "expired" | "soon" | "ok"; label: string };

/** How an expiry date reads today (both dates are plain YYYY-MM-DD in the co-op's calendar). */
export function expiryState(expiresOn: string | null, today: string, soonDays = 60): ExpiryState | null {
  if (!expiresOn) return null;
  const days = dayNumber(expiresOn) - dayNumber(today);
  if (days < 0) return { tone: "expired", label: days === -1 ? "Expired yesterday" : `Expired ${-days} days ago` };
  if (days === 0) return { tone: "soon", label: "Expires today" };
  if (days <= soonDays) return { tone: "soon", label: days === 1 ? "Expires tomorrow" : `Expires in ${days} days` };
  return { tone: "ok", label: "Current" };
}

/** Why a record cannot be erased yet, or null. Mirrors admin_erase_record, which checks again. */
export function eraseBlocker(record: { archived_at: string | null; retain_until: string | null }, today: string): string | null {
  if (!record.archived_at) return "Archive the record first. Erasing is a separate step.";
  if (record.retain_until && record.retain_until > today) return `This record is marked to be kept until ${longDate(record.retain_until)}.`;
  return null;
}

export type RecordSnapshot = Record<string, unknown>;

const SNAPSHOT_LABELS: Record<string, string> = {
  title: "title", category: "category", issuer: "issuer", reference_number: "reference number", effective_on: "effective date",
  expires_on: "expiry date", amount_cents: "amount", notes: "notes", tags: "tags", sensitive: "sensitive", retain_until: "keep-until date",
  archived: "archived",
};

/** Which fields differ between two revisions' snapshots, in plain words. */
export function snapshotChanges(before: RecordSnapshot | null, after: RecordSnapshot): string[] {
  if (!before) return [];
  return Object.keys(SNAPSHOT_LABELS).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)).map((key) => SNAPSHOT_LABELS[key]);
}

/** A line for an audit_log entry about a record (actions written by the vault's functions). */
export function describeRecordEvent(action: string, detail: Record<string, unknown> | null): string {
  const version = typeof detail?.version_no === "number" ? ` (version ${detail.version_no})` : "";
  switch (action) {
    case "record_created": return "Added the record";
    case "record_updated": return "Changed the record";
    case "record_archived": return "Archived the record";
    case "record_restored": return "Restored the record";
    case "record_file_added": return `Added the file${version}`;
    case "record_file_replaced": return `Added a new version of the file${version}`;
    case "record_file_viewed": return `Viewed the file${version}`;
    case "record_file_downloaded": return `Downloaded the file${version}`;
    default: return action.replace(/_/g, " ");
  }
}

/**
 * Upload first, then register: the path is checked by the storage policy and the size and type are read back from
 * storage by admin_add_record_file. A file that uploads but cannot be registered is removed again (the policy lets
 * the uploader remove a file no record points at), so nothing is left behind. Returns the new version number.
 */
export async function uploadRecordFile(supabase: SupabaseClient, recordId: string, file: File, changeNote: string | null): Promise<number> {
  const problem = recordFileProblem(file);
  if (problem) throw new Error(problem);
  const fileId = crypto.randomUUID();
  const path = recordFilePath(recordId, fileId, file.type);
  const sha = await sha256Hex(file);
  const upload = await supabase.storage.from(RECORDS_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
  if (upload.error) throw new Error(upload.error.message);
  const { data, error } = await supabase.rpc("admin_add_record_file", {
    p_record: recordId, p_file_id: fileId, p_path: path, p_file_name: file.name, p_sha256: sha, p_change_note: changeNote || null,
  });
  if (error) {
    await supabase.storage.from(RECORDS_BUCKET).remove([path]);
    throw new Error(error.message);
  }
  return data as number;
}

/**
 * The one way to read a file: admin_open_record_file writes the audit entry and opens a two-minute grant, and the
 * signed link is made inside it. A download link names the file so the browser saves it rather than shows it.
 */
export async function recordFileUrl(supabase: SupabaseClient, fileId: string, purpose: "view" | "download", fileName?: string): Promise<string> {
  const { data: path, error } = await supabase.rpc("admin_open_record_file", { p_file: fileId, p_purpose: purpose });
  if (error || !path) throw new Error(error?.message ?? "The file could not be opened.");
  const options = purpose === "download" ? { download: fileName || true } : undefined;
  const signed = await supabase.storage.from(RECORDS_BUCKET).createSignedUrl(path as string, 120, options);
  if (signed.error || !signed.data) throw new Error(signed.error?.message ?? "The file could not be opened.");
  return signed.data.signedUrl;
}

/** After admin_erase_record: clears the files it returned (allowed for ten minutes, to the administrator who erased). */
export async function removeErasedFiles(supabase: SupabaseClient, paths: string[]): Promise<string | null> {
  if (!paths.length) return null;
  const { error } = await supabase.storage.from(RECORDS_BUCKET).remove(paths);
  return error ? error.message : null;
}
