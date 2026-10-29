import { extractLines } from "./extract.ts";
import { type ParseOptions, type PdfStatement, parsePdfLines } from "./templates.ts";

export {
  type ParseOptions,
  PdfError,
  type PdfStatement,
  type PdfTemplate,
  parsePdfLines,
  TEMPLATES,
} from "./templates.ts";
export { extractLines };

/** A PDF statement's transactions, read on the device: text layer → lines → template. */
export async function parsePdf(
  bytes: Uint8Array,
  parseAmount: (text: string) => Promise<number>,
  options: ParseOptions = {},
): Promise<PdfStatement> {
  return parsePdfLines(await extractLines(bytes), parseAmount, options);
}
