import { RECEIPT_MARK } from "./receipt-mark.ts";

/**
 * A one-page PDF receipt, written by hand and kept quiet so it prints well on any printer: black and gray on white,
 * the Veritas Village mark in black, hairline rules, no filled areas. The standard Helvetica and Times fonts need
 * no embedding, so there is no library and no font file to ship (Times-Bold stands in for the site's Playfair
 * Display headings). Text outside Latin-1 is replaced with "?" rather than risk a broken file.
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

// Gray levels only ("g" values for the PDF gray colour operators): nothing here needs colour ink.
const BLACK = "0";
const DARK = "0.25";
const MID = "0.45";
const RULE = "0.75";
const HAIR = "0.88";

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
  const text = (x: number, y: number, size: number, value: string, opts: { font?: Font; gray?: string; spacing?: number } = {}) =>
    ops.push(`BT ${opts.gray ?? BLACK} g ${opts.spacing ?? 0} Tc /${opts.font ?? "F1"} ${size} Tf ${x} ${y} Td (${esc(value)}) Tj ET`);
  const rule = (y: number, gray = RULE, width = 0.75, x1 = MARGIN, x2 = PAGE_W - MARGIN) =>
    ops.push(`${gray} G ${width} w ${x1} ${y} m ${x2} ${y} l S`);
  const cardW = PAGE_W - MARGIN * 2;

  // Letterhead: the mark, the co-op's name and legal details.
  const markH = 56;
  const markW = (markH * RECEIPT_MARK.width) / RECEIPT_MARK.height;
  ops.push(`q ${markW.toFixed(2)} 0 0 ${markH} ${MARGIN} 686 cm /Im1 Do Q`);
  const textX = MARGIN + markW + 16;
  text(textX, 722, 20, r.orgName, { font: "F3" });
  let y = 706;
  if (r.orgEin) { text(textX, y, 9, `EIN ${r.orgEin}`, { gray: MID }); y -= 12; }
  for (const line of wrap(r.orgAddress ?? "", 70).slice(0, 3)) { if (line) { text(textX, y, 9, line, { gray: MID }); y -= 12; } }
  rule(670);

  // Title and number.
  text(MARGIN, 628, 24, r.kind === "refund" ? "Refund confirmation" : "Payment receipt", { font: "F3" });
  text(MARGIN, 608, 10, `No. ${r.receiptNumber}`, { gray: MID });

  // The facts, in plain rows.
  const rows: { label: string; lines: string[] }[] = [
    { label: "Date", lines: [r.date] },
    { label: "Household", lines: wrap(r.household, 56) },
    { label: "For", lines: wrap(r.description, 56) },
    { label: "Paid by", lines: wrap(r.method, 56) },
  ];
  if (r.reference) rows.push({ label: r.kind === "refund" ? "Reason" : "Reference", lines: wrap(r.reference, 56).slice(0, 4) });
  y = 572;
  rows.forEach((row) => {
    text(MARGIN, y, 8, row.label.toUpperCase(), { font: "F2", gray: MID, spacing: 1 });
    row.lines.forEach((line, i) => text(MARGIN + 110, y - i * 14, 11, line));
    y -= Math.max(row.lines.length, 1) * 14 + 10;
    rule(y + 2, HAIR, 0.5);
    y -= 14;
  });

  // The amount: one line, set between two rules.
  y -= 6;
  rule(y + 22, BLACK, 1);
  text(MARGIN, y - 2, 9, r.kind === "refund" ? "AMOUNT REFUNDED" : "AMOUNT PAID", { font: "F2", gray: DARK, spacing: 1 });
  text(MARGIN + cardW - moneyWidth(r.amount, 22), y - 4, 22, r.amount, { font: "F3" });
  rule(y - 20, BLACK, 1);
  y -= 50;

  if (r.footerNote) for (const line of wrap(r.footerNote, 96)) { text(MARGIN, y, 9, line, { gray: MID }); y -= 13; }

  if (r.testMode) {
    ops.push(`${BLACK} G 1.25 w ${MARGIN} 100 ${cardW} 30 re S`);
    text(MARGIN + 14, 111, 10, "TEST MODE - no real money moved. This is not a valid receipt.", { font: "F2" });
  }

  rule(72, HAIR, 0.5);
  text(MARGIN, 56, 8, "Veritas Village Family Portal", { gray: MID });

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
