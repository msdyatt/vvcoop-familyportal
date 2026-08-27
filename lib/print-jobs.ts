import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Queues a teacher's uploaded print request for the office printer (a Brother
 * HL-L3300CDW) in addition to -- not instead of -- the existing manual
 * print_requests queue (the "Send to print queue" button in PrintSection).
 * Nothing sends this anywhere yet: a Raspberry Pi script, not built yet, will
 * eventually poll the printer-dispatch edge function, download `storagePath`
 * from storage, and submit it over IPP/CUPS using the `sides` value worked
 * out here. Unlike an admin report (rendered from this app's own DOM, so it
 * carries an HTML snapshot), a teacher's upload is an arbitrary file --
 * whatever print_requests already accepts -- so it's queued by storage path
 * instead, and the eventual dispatcher hands that off to CUPS directly.
 */
export async function queueFilePrintJob(
  supabase: SupabaseClient,
  opts: { title: string; storagePath: string; duplex: boolean; copies?: number; orientation?: "portrait" | "landscape" },
): Promise<string | null> {
  const orientation = opts.orientation ?? "portrait";
  // Landscape duplex has to bind on the short edge to keep the second side
  // right-side-up when flipped -- binding on the long edge (the default for
  // portrait) would print every other page upside down.
  const sides = !opts.duplex ? "one-sided" : orientation === "landscape" ? "two-sided-short-edge" : "two-sided-long-edge";
  const { error } = await supabase.from("print_jobs").insert({
    title: opts.title,
    storage_path: opts.storagePath,
    duplex: opts.duplex,
    orientation,
    sides,
    copies: opts.copies ?? 1,
  });
  return error ? error.message : null;
}
