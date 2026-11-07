import { degrees, PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

/**
 * Drawing a signed record: flattening what people entered onto the original
 * PDF, and appending the certificate page. No network, no database; the bytes
 * go in and the bytes come out, so it can be tested with a throwaway PDF.
 */

export type SealRequest = {
  id: string;
  title: string;
  status: string;
  original_path: string;
  original_sha256: string;
  page_count: number;
  template_id: string;
  signing_order: string;
  sealed_sha256: string | null;
  document_id: string | null;
};
export type Mark = { kind: "typed"; text: string } | { kind: "drawn"; png: string };
export type SealSigner = {
  id: string; slot: number; display_name: string; email: string | null; status: string;
  consented_at: string | null; consent_text_sha256: string | null; signed_at: string | null;
  signature: Mark | null; initials: Mark | null;
};
export type SealField = {
  id: string; page: number; x: number; y: number; w: number; h: number;
  kind: "signature" | "initials" | "date" | "text" | "checkbox"; signer_slot: number; label: string | null;
};
export type SealValue = { field_id: string; signer_id: string; value: string };
export type SealEvent = {
  id: number; signer_id: string | null; action: string; actor_name: string | null;
  ip: string | null; user_agent: string | null; detail: Record<string, unknown>; created_at: string;
};
export type SealRecord = { signers: SealSigner[]; fields: SealField[]; values: SealValue[]; events: SealEvent[] };

export type TimestampInfo = {
  authority: string;
  genTime: string;
  serial: string;
  digestAlgorithm: string;
  imprintHex: string;
  covers: string;
};

const INK = rgb(0.043, 0.165, 0.239);
const GREY = rgb(0.35, 0.35, 0.35);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Replaces anything the built-in PDF fonts cannot encode, so a stray emoji cannot sink a seal. */
export function encodable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    try {
      font.widthOfTextAtSize(ch, 1);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

/**
 * Maps a point in the page as a person sees it (x from the left, y up from the
 * bottom, in points) to the page's own coordinate space, which is what a PDF
 * content stream is drawn in. `rotation` is the page's /Rotate (clockwise).
 */
export function visibleToPage(
  box: { x: number; y: number; width: number; height: number }, rotation: number, vx: number, vy: number,
): { x: number; y: number } {
  const w = box.width;
  const h = box.height;
  const visibleHeight = rotation === 90 || rotation === 270 ? w : h;
  const dx = vx;
  const dy = visibleHeight - vy;
  switch (((rotation % 360) + 360) % 360) {
    case 90: return { x: box.x + dy, y: box.y + dx };
    case 180: return { x: box.x + w - dx, y: box.y + dy };
    case 270: return { x: box.x + w - dy, y: box.y + h - dx };
    default: return { x: box.x + dx, y: box.y + h - dy };
  }
}

function fitSize(font: PDFFont, text: string, maxWidth: number, maxSize: number, minSize = 5): number {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Puts every signature, initial, date, text answer and tick onto the original pages. */
export async function flattenSigned(original: Uint8Array, record: SealRecord, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const script = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const pages = doc.getPages();
  const signerBySlot = new Map(record.signers.map((s) => [s.slot, s]));
  const valueByField = new Map(record.values.map((v) => [v.field_id, v.value]));

  for (const field of record.fields) {
    const value = valueByField.get(field.id);
    if (value === undefined) continue;
    const page: PDFPage | undefined = pages[field.page - 1];
    const signer = signerBySlot.get(field.signer_slot);
    if (!page || !signer) continue;

    const cb = page.getCropBox();
    const rotation = page.getRotation().angle;
    const vw = rotation === 90 || rotation === 270 ? cb.height : cb.width;
    const vh = rotation === 90 || rotation === 270 ? cb.width : cb.height;
    const bw = field.w * vw;
    const bh = field.h * vh;
    // Bottom-left corner of the field as the person sees it.
    const origin = visibleToPage(cb, rotation, field.x * vw, vh - (field.y + field.h) * vh);
    const rotate = degrees(((rotation % 360) + 360) % 360);
    // Everything below is positioned relative to the field's own corner, in the
    // page's visible orientation, then rotated into place for rotated pages.
    const at = (dx: number, dy: number) => {
      const r = (rotation * Math.PI) / 180;
      // A page shown rotated clockwise by r needs offsets rotated counter-clockwise by r in page space.
      return { x: origin.x + dx * Math.cos(r) - dy * Math.sin(r), y: origin.y + dx * Math.sin(r) + dy * Math.cos(r) };
    };

    if (field.kind === "signature" || field.kind === "initials") {
      const mark = field.kind === "signature" ? signer.signature : signer.initials;
      if (!mark) continue;
      if (mark.kind === "typed") {
        const text = encodable(script, mark.text);
        const size = fitSize(script, text, bw * 0.96, Math.min(bh * 0.72, 28));
        const p = at(bw * 0.02, bh * 0.28);
        page.drawText(text, { x: p.x, y: p.y, size, font: script, color: INK, rotate });
      } else {
        const img = await doc.embedPng(base64ToBytes(mark.png));
        const scale = Math.min(bw / img.width, bh / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const p = at((bw - w) / 2, (bh - h) / 2);
        page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate });
      }
    } else if (field.kind === "checkbox") {
      const side = Math.min(bw, bh);
      const p = at(0, 0);
      page.drawRectangle({ x: p.x, y: p.y, width: side, height: side, borderColor: INK, borderWidth: 0.8, rotate });
      if (value === "true") {
        const a = at(side * 0.2, side * 0.2);
        const b = at(side * 0.8, side * 0.8);
        const c = at(side * 0.2, side * 0.8);
        const d = at(side * 0.8, side * 0.2);
        page.drawLine({ start: a, end: b, thickness: 1.2, color: INK });
        page.drawLine({ start: c, end: d, thickness: 1.2, color: INK });
      }
    } else {
      const text = encodable(helv, value);
      const size = fitSize(helv, text, bw * 0.98, Math.min(bh * 0.7, 11));
      const p = at(bw * 0.01, bh * 0.28);
      page.drawText(text, { x: p.x, y: p.y, size, font: helv, color: INK, rotate });
    }
  }

  doc.setTitle(title);
  doc.setProducer("Veritas Village Family Portal");
  doc.setCreator("Veritas Village Family Portal");
  doc.setModificationDate(new Date());
  return await doc.save({ useObjectStreams: false });
}

// --- certificate -------------------------------------------------------------------------

const LETTER: [number, number] = [612, 792];
const MARGIN = 54;

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
export function formatCentral(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
  return parts;
}
const both = (iso: string | null | undefined) => (iso ? `${formatUtc(iso)}  (${formatCentral(iso)})` : "—");

class Writer {
  page!: PDFPage;
  y = 0;
  pageNumber = 0;
  constructor(readonly doc: PDFDocument, readonly regular: PDFFont, readonly bold: PDFFont, readonly mono: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage(LETTER);
    this.pageNumber += 1;
    this.y = LETTER[1] - MARGIN;
  }
  need(height: number) {
    if (this.y - height < MARGIN + 24) this.newPage();
  }
  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of encodable(font, text).split(/\n/)) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        // Break words longer than a line (hashes, user agents).
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width) {
          let cut = w.length;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut -= 1;
          if (line) { lines.push(line); line = ""; }
          lines.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const trial = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(trial, size) <= width) line = trial;
        else { lines.push(line); line = w; }
      }
      lines.push(line);
    }
    return lines;
  }
  text(text: string, opts: { font?: PDFFont; size?: number; indent?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}) {
    const font = opts.font ?? this.regular;
    const size = opts.size ?? 9;
    const indent = opts.indent ?? 0;
    for (const line of this.wrap(text, font, size, LETTER[0] - MARGIN * 2 - indent)) {
      this.need(size + 3);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y - size, size, font, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
      this.y -= size + 3;
    }
    this.y -= opts.gap ?? 0;
  }
  heading(text: string) {
    this.need(30);
    this.y -= 8;
    this.page.drawText(encodable(this.bold, text.toUpperCase()), { x: MARGIN, y: this.y - 10, size: 10, font: this.bold, color: INK });
    this.y -= 14;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: LETTER[0] - MARGIN, y: this.y }, thickness: 0.6, color: INK });
    this.y -= 6;
  }
}

function hashLines(hex: string): string {
  return `${hex.slice(0, 32)}\n${hex.slice(32)}`;
}

function eventLabel(action: string): string {
  return ({
    created: "Created", sent: "Sent for signature", viewed: "Opened", consent_given: "Agreed to sign electronically",
    field_filled: "Filled in fields", signed: "Signed", completed: "Sealed", voided: "Voided", downloaded: "Downloaded",
    reminded: "Reminder sent", timestamped: "Trusted timestamp", seal_failed: "Sealing failed",
  } as Record<string, string>)[action] ?? action;
}

/** Appends the certificate page(s) to a signed body PDF and returns the final bytes. */
export async function appendCertificate(
  body: Uint8Array,
  req: SealRequest,
  record: SealRecord,
  info: { bodySha256: string; sealedAt: Date; timestamp?: TimestampInfo | null },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(body, { updateMetadata: false });
  const w = new Writer(
    doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold),
    await doc.embedFont(StandardFonts.Courier),
  );
  const firstCertificatePage = doc.getPageCount();

  w.page.drawText("VERITAS VILLAGE", { x: MARGIN, y: w.y - 9, size: 9, font: w.bold, color: GREY });
  w.y -= 18;
  w.page.drawText("Certificate of Completion", { x: MARGIN, y: w.y - 20, size: 20, font: w.bold, color: INK });
  w.y -= 30;
  w.text(req.title, { font: w.bold, size: 12, gap: 2 });
  w.text(`Request ${req.id}`, { font: w.mono, size: 8, color: GREY });

  w.heading("The document");
  w.text("Original file SHA-256 (as uploaded and sent)", { size: 8, color: GREY });
  w.text(hashLines(req.original_sha256), { font: w.mono, size: 8.5, gap: 3 });
  w.text("Signed content SHA-256 (the original with the entries above placed on it, before this page)", { size: 8, color: GREY });
  w.text(hashLines(info.bodySha256), { font: w.mono, size: 8.5, gap: 3 });
  w.text(`Pages signed: ${req.page_count}.  Signing order: ${req.signing_order === "sequential" ? "one after the other" : "either order"}.`);
  w.text(`Sealed: ${both(info.sealedAt.toISOString())}`);

  w.heading("Signers");
  const consentEvents = new Map<string, SealEvent>();
  const signedEvents = new Map<string, SealEvent>();
  for (const e of record.events) {
    if (!e.signer_id) continue;
    if (e.action === "consent_given" && !consentEvents.has(e.signer_id)) consentEvents.set(e.signer_id, e);
    if (e.action === "signed") signedEvents.set(e.signer_id, e);
  }
  for (const s of [...record.signers].sort((a, b) => a.slot - b.slot)) {
    const consent = consentEvents.get(s.id);
    const signed = signedEvents.get(s.id);
    w.need(80);
    w.text(`${s.slot}. ${s.display_name}`, { font: w.bold, size: 10 });
    w.text(`Account email: ${s.email ?? "removed at the person's request"}`, { indent: 12 });
    w.text(`Agreed to sign electronically: ${both(s.consented_at)}`, { indent: 12 });
    w.text(`Signed: ${both(s.signed_at)}`, { indent: 12 });
    w.text(`Signature: ${s.signature?.kind === "typed" ? `typed, "${s.signature.text}"` : s.signature ? "drawn on screen" : "—"}`, { indent: 12 });
    w.text(`Signed from IP address: ${signed?.ip ?? "not recorded"}`, { indent: 12 });
    w.text(`Browser: ${signed?.user_agent ?? "not recorded"}`, { indent: 12 });
    if (consent?.ip && consent.ip !== signed?.ip) w.text(`Consent given from IP address: ${consent.ip}`, { indent: 12 });
    w.y -= 4;
  }

  if (info.timestamp) {
    const t = info.timestamp;
    w.heading("Trusted timestamp (RFC 3161)");
    w.text(`Authority: ${t.authority}`);
    w.text(`Time stamped: ${both(t.genTime)}`);
    w.text(`Serial number: ${t.serial}`, { font: w.mono, size: 8.5 });
    w.text(`Covers: ${t.covers}`);
    w.text(`${t.digestAlgorithm} imprint:`, { size: 8, color: GREY });
    w.text(hashLines(t.imprintHex), { font: w.mono, size: 8.5, gap: 2 });
  }

  w.heading("Audit trail");
  // Collapse runs of "filled in fields" by the same person into one row.
  type Row = { at: string; what: string; who: string; ip: string };
  const rows: Row[] = [];
  for (const e of record.events) {
    const last = rows[rows.length - 1];
    if (e.action === "field_filled" && last && last.what.startsWith("Filled in fields") && last.who === (e.actor_name ?? "")) {
      const n = Number(last.what.match(/\((\d+)\)/)?.[1] ?? 1) + 1;
      last.what = `Filled in fields (${n})`;
      continue;
    }
    rows.push({
      at: formatUtc(e.created_at).replace(" UTC", ""),
      what: e.action === "field_filled" ? "Filled in fields (1)" : eventLabel(e.action),
      who: e.actor_name ?? "", ip: e.ip ?? "",
    });
  }
  const cols = [MARGIN, MARGIN + 112, MARGIN + 270, MARGIN + 420];
  w.need(14);
  for (const [i, head] of ["Time (UTC)", "Event", "By", "IP address"].entries()) {
    w.page.drawText(head, { x: cols[i], y: w.y - 8, size: 8, font: w.bold, color: GREY });
  }
  w.y -= 13;
  for (const r of rows) {
    w.need(12);
    const cells = [r.at, r.what, r.who, r.ip];
    for (const [i, cell] of cells.entries()) {
      const font = i === 0 || i === 3 ? w.mono : w.regular;
      const maxW = (cols[i + 1] ?? LETTER[0] - MARGIN) - cols[i] - 6;
      let c = encodable(font, cell);
      while (c.length > 1 && font.widthOfTextAtSize(c, 8) > maxW) c = c.slice(0, -1);
      w.page.drawText(c, { x: cols[i], y: w.y - 8, size: 8, font, color: rgb(0.1, 0.1, 0.1) });
    }
    w.y -= 11;
  }

  w.heading("What this certificate does and does not prove");
  w.text(
    "Each signer was signed in to their own Family Village account when they agreed to sign electronically and when they signed. " +
    "The time, IP address and browser above were recorded by the server, not reported by the signer. " +
    "The two SHA-256 values identify the file that was sent and the signed content exactly; changing a single byte changes them.",
    { size: 8.5, gap: 3 },
  );
  w.text(
    info.timestamp
      ? "The trusted timestamp is an RFC 3161 token from an independent time-stamping authority over the signed content hash. It shows that content existed unchanged at that time. It can be checked with OpenSSL (see the co-op's verification notes)."
      : "No independent trusted timestamp is attached to this record.",
    { size: 8.5, gap: 3 },
  );
  w.text(
    "This is an electronic record with a recorded signing process. It is not a certificate-based digital signature (PAdES) embedded in the PDF. " +
    "Whether it satisfies a particular legal requirement is a question for the co-op's attorney.",
    { size: 8.5 },
  );

  // Footer on each certificate page.
  const total = doc.getPageCount();
  for (let i = firstCertificatePage; i < total; i++) {
    doc.getPage(i).drawText(
      `Certificate for request ${req.id}  ·  page ${i - firstCertificatePage + 1} of ${total - firstCertificatePage}`,
      { x: MARGIN, y: MARGIN - 14, size: 7.5, font: w.regular, color: GREY },
    );
  }

  doc.setProducer("Veritas Village Family Portal");
  doc.setModificationDate(info.sealedAt);
  return await doc.save({ useObjectStreams: false });
}
