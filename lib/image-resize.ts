/**
 * Shrinks a photo before it is uploaded: longest side at most `maxSide`, JPEG.
 *
 * Re-drawing onto a canvas also drops everything else in the original file,
 * including the GPS position and camera details phones embed. Photos of
 * children are shared here, so that is deliberate, not a side effect.
 */
export async function resizeImage(file: File, maxSide = 1600, quality = 0.85): Promise<File> {
  if (!file.type.startsWith("image/")) throw new Error("That file is not a photo.");
  // imageOrientation applies the phone's rotation before the metadata is dropped.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't prepare photos.");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("The photo could not be prepared.");
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}
