"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * A deliberately small, dependency-free square cropper for account photos.
 * The controls stay understandable on a phone and the exported JPEG is large
 * enough for portal avatars without storing a full camera original.
 *
 * The largest an avatar is ever actually shown is .avatar-lg at 72px (app/
 * globals.css) -- 240px covers that at 3x retina with room to spare, so
 * exporting at 512px (the original figure here) was several times more data
 * than any real display size in this app ever uses.
 *
 * The preview and the export share one geometry calculation (`geometry()`)
 * instead of two independent approximations of it. The first version used
 * CSS object-fit + a rough translate/scale for the preview and a separate
 * pixel calculation for the export -- the two didn't actually correspond:
 * at the default zoom, panning could visibly move the preview while having
 * zero effect on the saved file (the axis matching the source photo's
 * shorter side has no room to pan until you zoom in -- there's no more of
 * the image left in that direction to reveal, the same way object-fit:cover
 * can't show more than the image contains). Rendering the preview from the
 * exact sourceX/sourceY/cropSize the export uses means a pan with no real
 * effect now visibly does nothing in the preview too, instead of lying.
 */
const AVATAR_EXPORT_SIZE = 240;

export default function AvatarCropper({ file, busy, onCancel, onSave }: {
  file: File;
  busy: boolean;
  onCancel: () => void;
  onSave: (cropped: File) => Promise<void>;
}) {
  const [zoom, setZoom] = useState(1);
  const [horizontal, setHorizontal] = useState(0);
  const [vertical, setVertical] = useState(0);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [message, setMessage] = useState("");
  const source = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => () => URL.revokeObjectURL(source), [source]);

  // A new photo starts from a clean slate -- otherwise the previous photo's
  // zoom/pan silently carries over and can be saved against a photo the user
  // never actually adjusted.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset zoom/pan/dimensions synchronously so a new file never renders with the previous photo's adjustments
    setZoom(1); setHorizontal(0); setVertical(0); setDimensions(null); setMessage("");
    let cancelled = false;
    createImageBitmap(file).then((bitmap) => {
      if (!cancelled) setDimensions({ width: bitmap.width, height: bitmap.height });
      bitmap.close();
    }).catch(() => { if (!cancelled) setMessage("This photo could not be loaded."); });
    return () => { cancelled = true; };
  }, [file]);

  /** The square window of source pixels the current zoom/pan selects. */
  function geometry(width: number, height: number) {
    const cropSize = Math.min(width, height) / zoom;
    const travelX = Math.max(0, (width - cropSize) / 2);
    const travelY = Math.max(0, (height - cropSize) / 2);
    const sourceX = Math.max(0, Math.min(width - cropSize, (width - cropSize) / 2 - (horizontal / 100) * travelX));
    const sourceY = Math.max(0, Math.min(height - cropSize, (height - cropSize) / 2 - (vertical / 100) * travelY));
    return { cropSize, sourceX, sourceY };
  }

  async function save() {
    if (!dimensions) return;
    setMessage("");
    try {
      const bitmap = await createImageBitmap(file);
      const { cropSize, sourceX, sourceY } = geometry(dimensions.width, dimensions.height);
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_EXPORT_SIZE;
      canvas.height = AVATAR_EXPORT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the photo.");
      context.drawImage(bitmap, sourceX, sourceY, cropSize, cropSize, 0, 0, AVATAR_EXPORT_SIZE, AVATAR_EXPORT_SIZE);
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .82));
      if (!blob) throw new Error("This browser could not prepare the photo.");
      await onSave(new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "profile"}-avatar.jpg`, { type: "image/jpeg" }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The photo could not be cropped.");
    }
  }

  const frame = 180;
  const preview = dimensions ? geometry(dimensions.width, dimensions.height) : null;
  const displayScale = preview ? frame / preview.cropSize : 1;

  return <div className="avatar-cropper" role="dialog" aria-label="Adjust profile photo">
    <div className="avatar-crop-preview">
      {dimensions && preview
        ? <div
            className="avatar-crop-frame"
            style={{
              backgroundImage: `url(${source})`,
              backgroundRepeat: "no-repeat",
              backgroundSize: `${dimensions.width * displayScale}px ${dimensions.height * displayScale}px`,
              backgroundPosition: `${-preview.sourceX * displayScale}px ${-preview.sourceY * displayScale}px`,
            }}
          />
        : <p className="portal-empty">Loading…</p>}
      <span aria-hidden="true" />
    </div>
    <div className="avatar-crop-controls">
      <label>Zoom<input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} disabled={busy || !dimensions} /></label>
      <label>Move left or right<input type="range" min="-100" max="100" value={horizontal} onChange={(event) => setHorizontal(Number(event.target.value))} disabled={busy || !dimensions} /></label>
      <label>Move up or down<input type="range" min="-100" max="100" value={vertical} onChange={(event) => setVertical(Number(event.target.value))} disabled={busy || !dimensions} /></label>
    </div>
    <div className="row-actions">
      <button type="button" onClick={save} disabled={busy || !dimensions}>{busy ? "Saving…" : "Use this crop"}</button>
      <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancel</button>
    </div>
    {message && <p className="admin-form-status" role="status">{message}</p>}
  </div>;
}
