"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../lib/supabase";

/**
 * The Facebook group link, read from Admin → Integrations instead of typed
 * into source. It used to be a constant duplicated in two files -- changing
 * it meant a code change in both. Now it's one row, editable from the page
 * built for exactly this, and every place that links to the group reads the
 * same value.
 *
 * Renders nothing if the link isn't set, rather than a dead `#` anchor.
 */
export default function FacebookGroupLink({ className, children }: { className?: string; children: React.ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.from("integration_settings").select("external_url").eq("id", "facebook").maybeSingle();
      if (!cancelled) setUrl(data?.external_url ?? null);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (!url) return null;
  return <a className={className} href={url} target="_blank" rel="noreferrer">{children}</a>;
}
