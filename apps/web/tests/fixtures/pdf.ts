/**
 * A minimal one-page PDF writer for tests: Helvetica text lines at given positions, with a
 * correct cross-reference table, so a real PDF reader (pdf.js through unpdf) can extract the
 * text back. Not for production use; it writes only what the statement tests need.
 */

export interface PdfLine {
  x: number;
  y: number;
  text: string;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Lines are placed top to bottom when given with `y` from the top of a 792pt-high page. */
export function buildPdf(lines: PdfLine[]): Uint8Array {
  const content = lines
    .map((l) => `BT /F1 10 Tf ${l.x} ${792 - l.y} Td (${escapeText(l.text)}) Tj ET`)
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** A plausible checking statement in the common "date description amount balance" layout. */
export function sampleStatementPdf(): Uint8Array {
  const rows: Array<[string, string, string, string]> = [
    ["09/12", "DIRECT DEPOSIT ACME PAYROLL", "2,600.00", "3,814.22"],
    ["09/14", "CORNER MKT #214 1234567890124821", "-54.10", "3,760.12"],
    ["09/20", "ONLINE PAYMENT TO CARD 5555444433331173", "-1,200.00", "2,560.12"],
    ["10/02", "CHECK 1041", "-300.00", "2,260.12"],
  ];
  const lines: PdfLine[] = [
    { x: 50, y: 60, text: "First Example Bank" },
    { x: 50, y: 80, text: "Everyday Checking   Account number ****4821" },
    { x: 50, y: 100, text: "Statement period 09/10/2026 - 10/09/2026" },
    { x: 50, y: 130, text: "Date   Description   Amount   Balance" },
  ];
  rows.forEach((r, i) => {
    const y = 150 + i * 16;
    lines.push(
      { x: 50, y, text: r[0] },
      { x: 110, y, text: r[1] },
      { x: 400, y, text: r[2] },
      { x: 480, y, text: r[3] },
    );
  });
  lines.push({ x: 50, y: 240, text: "Ending balance 2,260.12" });
  return buildPdf(lines);
}
