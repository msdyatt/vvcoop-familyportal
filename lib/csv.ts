/** Minimal CSV writer: quotes any field containing a comma, quote, or newline. */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (value: string | number | null) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

/** Triggers a browser download of `content` as `filename`. */
export function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
