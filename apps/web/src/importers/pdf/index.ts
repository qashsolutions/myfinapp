import { extractLines } from "./extract.ts";
import { type PdfStatement, parsePdfLines } from "./templates.ts";

export { PdfError, type PdfStatement, type PdfTemplate, TEMPLATES } from "./templates.ts";

/** A PDF statement's transactions, read on the device: text layer → lines → template. */
export async function parsePdf(
  bytes: Uint8Array,
  parseAmount: (text: string) => Promise<number>,
): Promise<PdfStatement> {
  return parsePdfLines(await extractLines(bytes), parseAmount);
}
