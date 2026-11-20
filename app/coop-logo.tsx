"use client";

import { useCoopName } from "../lib/coop-settings";

/**
 * The co-op's logo: the horizontal lockup or the compact mark (docs/theming.md, "Co-op theme").
 *
 * Drawn as a background image from custom properties (app/theme.css, "The co-op's logos"), not as an <img>, so the
 * co-op's own files -- set on the document before the first paint by COOP_SCRIPT (lib/coop-theme.ts) -- show from
 * the start, with no flash of the bundled Veritas Village files, which are the defaults.
 *
 * `tone`: "auto" follows Light/Dark; "on-dark" is the version for a dark band in both themes (Admin's header);
 * "on-light" the version for paper and other always-light grounds.
 */
export default function CoopLogo({ kind = "lockup", tone = "auto", className = "", decorative = false }: {
  kind?: "lockup" | "mark";
  tone?: "auto" | "on-dark" | "on-light";
  className?: string;
  /** True when something next to it already names the co-op. */
  decorative?: boolean;
}) {
  const name = useCoopName();
  const classes = `coop-logo ${kind} ${tone} ${className}`.trim();
  return decorative
    ? <span className={classes} aria-hidden="true" />
    : <span className={classes} role="img" aria-label={name} />;
}
