"use client";

/**
 * A photo if there is one, otherwise the same initial-in-a-circle every part
 * of the portal already fell back to before this existed. Never renders a
 * broken image: the caller passes a signed URL it already resolved (or null),
 * so a failed sign-in-progress state degrades to initials rather than a
 * missing-image icon.
 */
export default function Avatar({ url, label, size = "md", tone, ring }: {
  url: string | null; label: string; size?: "sm" | "md" | "lg";
  /** Messages only: which of the six tints (lib/message-colors.ts) the initial circle takes. */
  tone?: number;
  /** Messages only: a ring for a role, gold for teachers and terracotta for administrators. */
  ring?: "teacher" | "admin" | null;
}) {
  const initial = label.trim().slice(0, 1).toUpperCase() || "?";
  const extra = `${tone === undefined ? "" : ` pc-${tone}`}${ring ? ` avatar-ring avatar-ring-${ring}` : ""}`;
  return url
    // next/image needs the Supabase storage domain allow-listed to optimize a
    // remote URL, and gains nothing here anyway -- `url` is a signed URL whose
    // token invalidates on every load, so there is no stable cache key for an
    // optimizer to key off of.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img className={`avatar avatar-${size}${extra}`} src={url} alt="" width={64} height={64} loading="lazy" decoding="async" />
    : <span className={`avatar avatar-${size} avatar-fallback${extra}`} aria-hidden="true">{initial}</span>;
}
