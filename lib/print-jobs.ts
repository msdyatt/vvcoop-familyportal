import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The printable-report / roster-print-sheet rules from globals.css, with
 * every `var(--…)` resolved to its literal value. A queued job has to render
 * correctly wherever it eventually gets turned into a page for the printer --
 * a headless browser on a Raspberry Pi, most likely -- which will not have
 * this app's stylesheet loaded, so the snapshot below has to carry its own.
 */
const SNAPSHOT_CSS = `
  body { margin:0; padding:24px; background:#fffdf9; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; color:#0b2a3d; }
  .printable-report, .roster-print-sheet, .roster-report-shell { border:0; padding:0; }
  .printable-report>header, .roster-print-head {
    display:flex; justify-content:space-between; gap:20px; align-items:start;
    margin-bottom:18px; padding-bottom:14px; border-bottom:2px solid #bb6141;
  }
  .printable-report>header p, .roster-print-head p { margin:0; color:#a85539; font-size:10px; font-weight:700; letter-spacing:.16em; }
  .printable-report h3, .roster-print-head h2 { margin:2px 0 0; font:600 28px "Playfair Display",Georgia,"Times New Roman",serif; }
  .printable-report table, .roster-print-sheet table { width:100%; border-collapse:collapse; font-size:12px; }
  .printable-report th, .printable-report td, .roster-print-sheet th, .roster-print-sheet td {
    padding:9px 8px; text-align:left; vertical-align:top; border-bottom:1px solid rgba(11,42,61,.14);
  }
  .roster-print-meta { display:grid; gap:8px; margin:0 0 18px; }
  .roster-print-meta div { display:grid; grid-template-columns:110px 1fr; }
  .roster-print-meta dt { color:#5f6b61; font-size:10px; font-weight:700; text-transform:uppercase; }
  .roster-print-meta dd { margin:0; font-size:12px; }
  .master-roster-table { margin-bottom:20px; }
  .master-roster-table thead tr:first-child th { padding-top:16px; padding-bottom:4px; color:#a85539; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; border-bottom:0; }
  .master-roster-table thead tr:nth-child(2) th { color:#5f6b61; font-size:10px; font-weight:700; text-transform:uppercase; }
  .master-roster-page { break-after:page; }
  .no-print, .roster-report-actions, button { display:none !important; }
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

/**
 * Wraps a report/roster element's markup into a standalone HTML document --
 * see SNAPSHOT_CSS above for why. `orientation` drives `@page { size }`
 * directly: every current report is landscape (globals.css sets it
 * unconditionally, since a wide roster table fights portrait), and a snapshot
 * that only carried that fact as a metadata column but defaulted its own
 * `@page` to portrait would print clipped tables despite claiming otherwise.
 */
export function buildPrintSnapshot(title: string, target: HTMLElement, orientation: "portrait" | "landscape"): string {
  const css = `${SNAPSHOT_CSS}\n  @page { size: ${orientation}; margin: 0.5in; }`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head><body>${target.outerHTML}</body></html>`;
}

/**
 * Queues a report for the office printer (a Brother HL-L3300CDW) rather than
 * -- or alongside -- the browser's own print dialog. Nothing sends this
 * anywhere yet: a Raspberry Pi script, not built yet, will eventually poll
 * the printer-dispatch edge function and submit each pending row over
 * IPP/CUPS using the `sides` value already worked out here.
 */
export async function queuePrintJob(
  supabase: SupabaseClient,
  opts: { title: string; target: HTMLElement | null; duplex: boolean; copies?: number; orientation?: "portrait" | "landscape" },
): Promise<string | null> {
  if (!opts.target) return "Nothing to print.";
  const orientation = opts.orientation ?? "landscape";
  // Landscape duplex has to bind on the short edge to keep the second side
  // right-side-up when flipped -- binding on the long edge (the default for
  // portrait) would print every other page upside down.
  const sides = !opts.duplex ? "one-sided" : orientation === "landscape" ? "two-sided-short-edge" : "two-sided-long-edge";
  const { error } = await supabase.from("print_jobs").insert({
    title: opts.title,
    html_body: buildPrintSnapshot(opts.title, opts.target, orientation),
    duplex: opts.duplex,
    orientation,
    sides,
    copies: opts.copies ?? 1,
  });
  return error ? error.message : null;
}
