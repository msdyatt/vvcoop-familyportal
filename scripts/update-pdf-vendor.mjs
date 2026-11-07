// Copies the PDF libraries into public/vendor so the site serves them itself.
// They are loaded in the browser on demand (lib/report-pdf.ts) rather than
// imported, because the production build targets a Cloudflare Worker and
// jsPDF has no worker entry. Run this after changing the jspdf versions.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/vendor", { recursive: true });
copyFileSync("node_modules/jspdf/dist/jspdf.umd.min.js", "public/vendor/jspdf.umd.min.js");
copyFileSync("node_modules/jspdf-autotable/dist/jspdf.plugin.autotable.min.js", "public/vendor/jspdf.plugin.autotable.min.js");
console.log("Copied the PDF libraries to public/vendor.");
