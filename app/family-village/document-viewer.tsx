"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase";
import { PRIVATE_BUCKET } from "../../lib/storage";
import PdfPages from "./pdf-pages";

const IMAGE_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

/**
 * Shows a stored file inside the portal instead of sending the person to a
 * storage link in a new tab. The file is fetched with the signed-in session,
 * PDFs are drawn page by page with the same viewer used for signing, images are
 * shown directly, and anything else offers a download that saves the file
 * without leaving the app.
 */
export default function DocumentViewer({ path, title }: { path: string; title: string }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = extension === "pdf";
  const imageType = IMAGE_TYPES[extension];

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).download(path);
      if (cancelled) return;
      if (error || !data) { setFailed(true); return; }
      const buffer = new Uint8Array(await data.arrayBuffer());
      url = URL.createObjectURL(new Blob([buffer], { type: isPdf ? "application/pdf" : imageType ?? data.type }));
      if (cancelled) { URL.revokeObjectURL(url); return; }
      setBytes(buffer);
      setBlobUrl(url);
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path, isPdf, imageType]);

  if (failed) return <p className="portal-empty" role="alert">This file could not be opened. Please try again.</p>;
  if (!bytes || !blobUrl) return <p className="portal-empty">Opening…</p>;

  const filename = `${title.replace(/[^\w.-]+/g, "_")}.${extension || "file"}`;
  return <div className="document-viewer">
    <a className="sign-big secondary compact" href={blobUrl} download={filename}>Download</a>
    <div className="document-viewer-scroll">
      {isPdf && <PdfPages data={bytes} maxWidth={760} />}
      {imageType && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={blobUrl} alt={title} />
      )}
      {!isPdf && !imageType && <p className="portal-empty">This kind of file cannot be shown here. Use Download to save it.</p>}
    </div>
  </div>;
}
