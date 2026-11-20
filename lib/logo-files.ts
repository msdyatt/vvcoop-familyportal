/** Checks on an image an admin picks as a logo (Admin, Appearance), before it is uploaded. Browser only. */
import { LOGO_MAX_BYTES, LOGO_TYPES } from "./coop-theme";

type Slot = "logo_light" | "logo_dark" | "mark_light" | "mark_dark";

function readImageShape(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { reject(new Error("That file could not be read as an image.")); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

/** Why a file cannot be a logo for this slot (a sentence), or its shape when it can. */
export async function logoProblem(slot: Slot, file: File): Promise<string | null | { ratio: number }> {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return "Use a PNG, JPEG or WebP file. PNG with a transparent background works best.";
  if (file.size > LOGO_MAX_BYTES) return `That file is ${(file.size / 1048576).toFixed(1)} MB. Logos can be up to 1 MB.`;
  const { width, height } = await readImageShape(file);
  const ratio = width / height;
  if (slot.startsWith("logo")) {
    if (ratio < 1 || ratio > 6) return "A logo here should be wider than it is tall (up to six times as wide). Use the compact mark slots for a square mark.";
    if (width < 300) return `That image is ${width} pixels wide. Use one at least 300 pixels wide so it stays sharp.`;
  } else {
    if (ratio < 0.75 || ratio > 1.33) return "A compact mark should be about square.";
    if (width < 96) return `That image is ${width} pixels wide. Use one at least 96 pixels wide.`;
  }
  return { ratio };
}

