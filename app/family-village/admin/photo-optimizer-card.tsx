"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "../../../lib/supabase";
import { PRIVATE_BUCKET, storeAvatar } from "../../../lib/storage";

/** Anything bigger than this is a camera original rather than a prepared avatar (those are about 15 KB). */
const TOO_BIG_BYTES = 120_000;

type Holder = { table: "profiles" | "children"; path: string };

/**
 * Shrinks profile and child photos that were saved as full-size originals.
 * Each oversized one is downloaded, cropped to a small square, stored under a
 * new name, pointed at by whoever used the old one, and the original removed.
 */
export default function PhotoOptimizerCard() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    setStatus("Looking at the photos…");
    try {
      const [{ data: profiles }, { data: children }] = await Promise.all([
        supabase.from("profiles").select("avatar_path").not("avatar_path", "is", null),
        supabase.from("children").select("avatar_path").not("avatar_path", "is", null),
      ]);
      const holders: Holder[] = [
        ...(profiles ?? []).map((row) => ({ table: "profiles" as const, path: row.avatar_path as string })),
        ...(children ?? []).map((row) => ({ table: "children" as const, path: row.avatar_path as string })),
      ];
      const paths = [...new Set(holders.map((holder) => holder.path))];
      let shrunk = 0, savedBytes = 0, failed = 0;

      for (const [index, path] of paths.entries()) {
        setStatus(`Checking photo ${index + 1} of ${paths.length}…`);
        const { data: signed } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(path, 300);
        if (!signed?.signedUrl) { failed += 1; continue; }
        const original = await (await fetch(signed.signedUrl)).blob();
        if (original.size <= TOO_BIG_BYTES) continue;

        const stored = await storeAvatar(supabase, new File([original], "photo", { type: original.type || "image/jpeg" }));
        if ("error" in stored) { failed += 1; continue; }
        const tables = [...new Set(holders.filter((holder) => holder.path === path).map((holder) => holder.table))];
        let repointed = true;
        for (const table of tables) {
          const { error } = await supabase.from(table).update({ avatar_path: stored.path }).eq("avatar_path", path);
          if (error) repointed = false;
        }
        if (!repointed) { failed += 1; continue; }
        await supabase.storage.from(PRIVATE_BUCKET).remove([path]);
        shrunk += 1;
        savedBytes += original.size;
      }

      const megabytes = (savedBytes / 1_000_000).toFixed(1);
      setStatus(shrunk || failed
        ? `Made ${shrunk} photo${shrunk === 1 ? "" : "s"} smaller (about ${megabytes} MB saved).${failed ? ` ${failed} could not be changed. Try again, or have that person upload it again.` : ""}`
        : "All photos are already small.");
    } catch {
      setStatus("Something went wrong while shrinking the photos. Nothing was lost; try again.");
    } finally {
      setBusy(false);
    }
  }

  return <article className="integration-card">
    <div className="integration-card-head"><h3>Photo sizes</h3></div>
    <p className="field-note">New photos are made small automatically. This shrinks any older profile or child photos that were saved at full size, which is what makes pages slow to fill in.</p>
    <div className="field-row">
      <button type="button" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : "Make existing photos smaller"}</button>
    </div>
    {status && <p className="admin-form-status" role="status">{status}</p>}
  </article>;
}
