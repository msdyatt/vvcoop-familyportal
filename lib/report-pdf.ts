import type { jsPDF as JsPdfClass } from "jspdf";
import type autoTableFn from "jspdf-autotable";
import type { ReportDoc } from "./report-doc";
import { shareBlob } from "./native-frame";

const MARGIN = 36;
const INK: [number, number, number] = [0, 0, 0];

export type PdfLibs = { jsPDF: typeof JsPdfClass; autoTable: typeof autoTableFn };

const loading = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let promise = loading.get(src);
  if (!promise) {
    promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => { loading.delete(src); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(script);
    });
    loading.set(src, promise);
  }
  return promise;
}

/**
 * The PDF libraries, served from this site's own /vendor folder and loaded the
 * first time a PDF is asked for. They are not imported: the production build
 * targets a Cloudflare Worker, and jsPDF has no worker entry. See
 * scripts/update-pdf-vendor.mjs.
 */
async function browserLibs(): Promise<PdfLibs> {
  await loadScript("/vendor/jspdf.umd.min.js");
  await loadScript("/vendor/jspdf.plugin.autotable.min.js");
  const globals = window as unknown as {
    jspdf: { jsPDF: typeof JsPdfClass };
    jspdfAutoTable?: { default?: typeof autoTableFn };
  };
  const jsPDF = globals.jspdf.jsPDF;
  // The plugin registers itself on jsPDF; call it as a method when no standalone function is exposed.
  const autoTable = globals.jspdfAutoTable?.default
    ?? (((doc: JsPdfClass, options: object) => (doc as unknown as { autoTable: (o: object) => void }).autoTable(options)) as unknown as typeof autoTableFn);
  return { jsPDF, autoTable };
}

/**
 * Draws a report into a PDF: black text and thin rules on white, no fills, so
 * it stays crisp when printed in greyscale.
 */
export async function makePdf(report: ReportDoc, libs?: PdfLibs): Promise<Blob> {
  const { jsPDF, autoTable } = libs ?? await browserLibs();
  const pdf = new jsPDF({ orientation: report.landscape ? "landscape" : "portrait", unit: "pt", format: "letter" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const usable = pageWidth - MARGIN * 2;

  pdf.setTextColor(...INK);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8);
  pdf.text("VERITAS VILLAGE", MARGIN, MARGIN + 6, { charSpace: 1.5 });
  pdf.setFontSize(18);
  pdf.text(report.title, MARGIN, MARGIN + 28);
  let y = MARGIN + 38;
  if (report.subtitle) {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(report.subtitle, MARGIN, y + 8);
    y += 14;
  }
  y += 8;

  for (const section of report.sections) {
    if (section.heading) {
      // Keep a heading with the start of its table rather than stranding it at the foot of a page.
      if (y > pageHeight - MARGIN - 70) { pdf.addPage(); y = MARGIN; }
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.text(section.heading, MARGIN, y + 10);
      if (section.aside) {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.text(section.aside, pageWidth - MARGIN, y + 10, { align: "right" });
      }
      y += 16;
    }
    const total = section.columns.reduce((sum, column) => sum + (column.weight ?? 1), 0);
    const columnStyles = Object.fromEntries(section.columns.map((column, index) => [index, { cellWidth: (usable * (column.weight ?? 1)) / total }]));
    autoTable(pdf, {
      startY: y,
      margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: MARGIN + 14 },
      head: [section.columns.map((column) => column.label)],
      body: section.rows,
      theme: "plain",
      rowPageBreak: "avoid",
      tableWidth: usable,
      columnStyles,
      styles: { font: "helvetica", fontSize: 8.5, cellPadding: 4, textColor: INK, lineColor: INK, lineWidth: 0.4, overflow: "linebreak", valign: "middle" },
      headStyles: { fontStyle: "bold", fillColor: false, textColor: INK, lineWidth: 0.7 },
      bodyStyles: { fillColor: false },
      alternateRowStyles: { fillColor: false },
    });
    y = (pdf as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
    y += 18;
  }

  const pages = pdf.getNumberOfPages();
  const printed = new Date().toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.text(`Printed ${printed}`, MARGIN, pageHeight - 20);
    pdf.text(`Page ${page} of ${pages}`, pageWidth - MARGIN, pageHeight - 20, { align: "right" });
  }
  return pdf.output("blob");
}

export type Delivery = "shared" | "opened" | "downloaded";

/**
 * Gets a PDF to the person. The installed app has no print dialog, so there it
 * goes through the phone's share sheet (which includes Print and Save to Files),
 * or opens in the viewer; on a computer it downloads.
 */
export async function deliverPdf(blob: Blob, filename: string): Promise<Delivery> {
  // The iPhone app's native frame has its own share sheet.
  try { if (await shareBlob(blob, filename)) return "shared"; } catch { /* fall through to the ordinary routes */ }
  const inApp = document.documentElement.dataset.app === "1";
  const file = new File([blob], filename, { type: "application/pdf" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (inApp && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return "shared";
    } catch (error) {
      if ((error as Error).name === "AbortError") return "shared";
    }
  }
  const url = URL.createObjectURL(blob);
  if (inApp) {
    window.open(url, "_blank");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "opened";
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return "downloaded";
}
