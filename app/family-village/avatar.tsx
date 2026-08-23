"use client";

/**
 * A photo if there is one, otherwise the same initial-in-a-circle every part
 * of the portal already fell back to before this existed. Never renders a
 * broken image: the caller passes a signed URL it already resolved (or null),
 * so a failed sign-in-progress state degrades to initials rather than a
 * missing-image icon.
 */
export default function Avatar({ url, label, size = "md" }: { url: string | null; label: string; size?: "sm" | "md" | "lg" }) {
  const initial = label.trim().slice(0, 1).toUpperCase() || "?";
  return url
    ? <img className={`avatar avatar-${size}`} src={url} alt="" width={64} height={64} />
    : <span className={`avatar avatar-${size} avatar-fallback`} aria-hidden="true">{initial}</span>;
}
