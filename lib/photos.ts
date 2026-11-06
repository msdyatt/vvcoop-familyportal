export type PhotoRow = {
  id: string; album_id: string | null; storage_path: string; thumb_path: string;
  caption: string | null; visibility: "coop" | "class"; class_id: string | null;
  school_year_id: string | null; taken_on: string | null; status: "pending" | "published";
  uploaded_by: string | null; created_at: string;
};

export const PHOTO_COLUMNS = "id,album_id,storage_path,thumb_path,caption,visibility,class_id,school_year_id,taken_on,status,uploaded_by,created_at";

export type Album = { id: string; title: string; class_id: string | null; school_year_id: string | null; event_on: string | null };
export type YearOption = { id: string; label: string; is_current: boolean };
export type ClassOption = { id: string; title: string };

export const PHOTO_PAGE = 36;

/** Escapes % and _ so a caption search is a plain substring match. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function photoDate(row: Pick<PhotoRow, "taken_on" | "created_at">): string {
  const iso = row.taken_on ?? row.created_at;
  const date = row.taken_on ? new Date(`${row.taken_on}T12:00:00`) : new Date(iso);
  return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}
