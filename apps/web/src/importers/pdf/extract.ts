/**
 * Text lines out of a PDF, on the device (fast-follow 2). pdf.js (through unpdf) gives every
 * text run with its position; runs that share a baseline become one line, left to right.
 * Nothing is uploaded and no image is rendered; scanned PDFs without a text layer yield no
 * lines, which the importer reports as unreadable.
 */

import { getDocumentProxy } from "unpdf";

interface Run {
  x: number;
  y: number;
  text: string;
  width: number;
}

/** Runs within this many points vertically sit on the same line. */
const LINE_TOLERANCE = 2.5;

export function joinRuns(runs: Run[]): string[] {
  const rows: Run[][] = [];
  for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row?.[0] && Math.abs(row[0].y - run.y) <= LINE_TOLERANCE) row.push(run);
    else rows.push([run]);
  }
  return rows
    .map((row) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((r) => r.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((line) => line.length > 0);
}

export async function extractLines(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const lines: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const runs: Run[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const t = item.transform as number[];
      runs.push({ x: t[4] ?? 0, y: t[5] ?? 0, text: item.str, width: item.width });
    }
    lines.push(...joinRuns(runs));
  }
  return lines;
}
