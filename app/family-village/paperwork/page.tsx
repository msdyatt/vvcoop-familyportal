"use client";

import { useEffect } from "react";

/**
 * Paperwork and Documents are one page now. The old address stays so bookmarks,
 * emails and notifications that point here still land in the right place.
 */
export default function PaperworkMovedPage() {
  useEffect(() => { window.location.replace("/family-village/documents"); }, []);
  return <main className="portal-state"><p><a href="/family-village/documents">Paperwork is now part of Documents →</a></p></main>;
}
