import { RECEIPT_MARK } from "./receipt-mark.ts";

/**
 * A one-page PDF receipt, written by hand in the Veritas Village look: a navy
 * header band with the mark, a cream page, terracotta accents. The standard
 * Helvetica and Times fonts need no embedding, so there is no library and no
 * font file to ship (Times-Bold stands in for the site's Playfair Display
 * headings). Text outside Latin-1 is replaced with "?" rather than risk a
 * broken file.
 */

export type ReceiptData = {
  kind: "payment" | "refund";
  orgName: string;
  orgEin: string | null;
  orgAddress: string | null;
  footerNote: string | null;
  receiptNumber: string;
  date: string;               // already formatted, e.g. "September 2, 2026"
  household: string;
  description: string;
  amount: string;             // already formatted, e.g. "$600.00"
  method: string;
  reference: string | null;
  testMode: boolean;
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;

// The brand colours as PDF "r g b" triples (see --navy, --cream, --terracotta, --sage in app/globals.css).
const NAVY = "0.043 0.165 0.239";
const CREAM = "0.980 0.969 0.945";
const TERRACOTTA = "0.733 0.380 0.255";
const SAGE = "0.435 0.490 0.447";
const SURFACE = "1 0.992 0.976";
const PANEL = "0.902 0.914 0.886";
const WARM_TINT = "0.957 0.894 0.863";
const SOFT_CREAM = "0.843 0.647 0.565";   // terracotta-on-navy: small text on the navy band

function esc(text: string): string {
  return [...text].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "(" || ch === ")") return `\\${ch}`;
    if (code === 0x2013 || code === 0x2014) return "-";
    if (code === 0x2018 || code === 0x2019) return "'";
    if (code === 0x201c || code === 0x201d) return '"';
    if (code === 0x2022) return "\\225";
    if (code < 32 || code > 255) return "?";
    if (code > 126) return `\\${code.toString(8).padStart(3, "0")}`;
    return ch;
  }).join("");
}

/** Greedy word wrap at roughly `max` characters. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if ((line + " " + word).trim().length > max && line) { lines.push(line); line = word; } else { line = (line + " " + word).trim(); }
    }
    lines.push(line);
  }
  return lines;
}

/** Width of a money string in Times-Bold: digits and "$" are 500 units, "," and "." 250. */
function moneyWidth(value: string, size: number): number {
  let units = 0;
  for (const ch of value) units += ch === "," || ch === "." ? 250 : ch === "-" ? 333 : 500;
  return (units / 1000) * size;
}

export function buildReceiptPdf(r: ReceiptData): Uint8Array {
  const ops: string[] = [];
  type Font = "F1" | "F2" | "F3";   // Helvetica, Helvetica-Bold, Times-Bold
  const text = (x: number, y: number, size: number, value: string, opts: { font?: Font; color?: string; spacing?: number } = {}) =>
    ops.push(`BT ${opts.color ?? NAVY} rg ${opts.spacing ?? 0} Tc /${opts.font ?? "F1"} ${size} Tf ${x} ${y} Td (${esc(value)}) Tj ET`);
  const fill = (color: string, x: number, y: number, w: number, h: number) => ops.push(`${color} rg ${x} ${y} ${w} ${h} re f`);

  // Page: cream field, navy header band, terracotta edge under it.
  fill(CREAM, 0, 0, PAGE_W, PAGE_H);
  fill(NAVY, 0, 652, PAGE_W, 140);
  fill(TERRACOTTA, 0, 648, PAGE_W, 4);

  // The mark, then the co-op's name and legal details.
  const markH = 72;
  const markW = (markH * RECEIPT_MARK.width) / RECEIPT_MARK.height;
  ops.push(`q ${markW.toFixed(2)} 0 0 ${markH} ${MARGIN} 676 cm /Im1 Do Q`);
  const textX = MARGIN + markW + 20;
  text(textX, 728, 26, r.orgName, { font: "F3", color: CREAM });
  let y = 710;
  if (r.orgEin) { text(textX, y, 9.5, `EIN ${r.orgEin}`, { color: SOFT_CREAM }); y -= 13; }
  for (const line of wrap(r.orgAddress ?? "", 70).slice(0, 3)) { if (line) { text(textX, y, 9.5, line, { color: SOFT_CREAM }); y -= 13; } }

  // Title.
  text(MARGIN, 604, 28, r.kind === "refund" ? "Refund confirmation" : "Payment receipt", { font: "F3" });
  text(MARGIN, 582, 10, `NO. ${r.receiptNumber}`, { font: "F2", color: TERRACOTTA, spacing: 1.2 });

  // Details card: measure the rows first so the card fits them.
  const rows: { label: string; lines: string[] }[] = [
    { label: "Date", lines: [r.date] },
    { label: "Household", lines: wrap(r.household, 52) },
    { label: "For", lines: wrap(r.description, 52) },
    { label: "Paid by", lines: wrap(r.method, 52) },
  ];
  if (r.reference) rows.push({ label: r.kind === "refund" ? "Reason" : "Reference", lines: wrap(r.reference, 52).slice(0, 4) });
  const rowHeight = (row: { lines: string[] }) => Math.max(row.lines.length, 1) * 15 + 12;
  const cardH = rows.reduce((sum, row) => sum + rowHeight(row), 0) + 28;
  const cardTop = 558;
  const cardW = PAGE_W - MARGIN * 2;
  ops.push(`${SURFACE} rg ${PANEL} RG 0.75 w ${MARGIN} ${cardTop - cardH} ${cardW} ${cardH} re B`);
  y = cardTop - 30;
  rows.forEach((row, index) => {
    text(MARGIN + 22, y, 8, row.label.toUpperCase(), { font: "F2", color: SAGE, spacing: 1.2 });
    row.lines.forEach((line, i) => text(MARGIN + 140, y - i * 15, 12, line));
    y -= rowHeight(row);
    if (index < rows.length - 1) ops.push(`${PANEL} RG 0.5 w ${MARGIN + 22} ${y + 17} m ${MARGIN + cardW - 22} ${y + 17} l S`);
  });

  // Amount, on a navy block.
  const blockTop = cardTop - cardH - 20;
  fill(NAVY, MARGIN, blockTop - 64, cardW, 64);
  fill(TERRACOTTA, MARGIN, blockTop - 64, 4, 64);
  text(MARGIN + 22, blockTop - 37, 9, r.kind === "refund" ? "AMOUNT REFUNDED" : "AMOUNT PAID", { font: "F2", color: SOFT_CREAM, spacing: 1.5 });
  text(MARGIN + cardW - 22 - moneyWidth(r.amount, 30), blockTop - 42, 30, r.amount, { font: "F3", color: CREAM });

  y = blockTop - 64 - 30;
  if (r.footerNote) for (const line of wrap(r.footerNote, 88)) { text(MARGIN, y, 10, line, { color: SAGE }); y -= 14; }

  if (r.testMode) {
    fill(WARM_TINT, MARGIN, 96, cardW, 34);
    fill(TERRACOTTA, MARGIN, 96, 4, 34);
    text(MARGIN + 16, 109, 11, "TEST MODE - no real money moved. This is not a valid receipt.", { font: "F2", color: TERRACOTTA });
  }

  ops.push(`${PANEL} RG 0.75 w ${MARGIN} 72 m ${PAGE_W - MARGIN} 72 l S`);
  text(MARGIN, 54, 9, "Generated by Veritas Village Family Portal.", { color: SAGE });

  const content = ops.join("\n");
  const rgb = atob(RECEIPT_MARK.rgb);
  const alpha = atob(RECEIPT_MARK.alpha);
  const image = (extra: string, colorSpace: string, data: string) =>
    `<< /Type /XObject /Subtype /Image /Width ${RECEIPT_MARK.width} /Height ${RECEIPT_MARK.height} /ColorSpace /${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode ${extra}/Length ${data.length} >>\nstream\n${data}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> /XObject << /Im1 8 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>",
    image("/SMask 9 0 R ", "DeviceRGB", rgb),
    image("", "DeviceGray", alpha),
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every character is single-byte (see esc, and atob for the image data), so length equals byte count.
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}
