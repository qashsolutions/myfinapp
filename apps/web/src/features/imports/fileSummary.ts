import { formatDate } from "../../lib/format.ts";
import type { ParsedFile } from "./importFlow.ts";

/**
 * One line saying what a picked statement holds, shown under its name before anything is
 * imported (November 16, 2026): the kind of file, how many transactions, the dates it covers and
 * the account, as far as the file says. Read on the device; nothing here is stored.
 */
export function fileSummary(parsed: ParsedFile): string {
  const parts: string[] = [];
  const n = parsed.rowCount;
  if (parsed.format === "csv") {
    parts.push("CSV", `${n} ${n === 1 ? "row" : "rows"}`);
    return parts.join(" · ");
  }
  const st = parsed.format === "pdf" ? parsed.pdf : parsed.ofx;
  parts.push(parsed.format === "pdf" ? "PDF statement" : "OFX statement");
  parts.push(`${n} ${n === 1 ? "transaction" : "transactions"}`);
  const { start, end } = st?.period ?? { start: null, end: null };
  if (start && end) parts.push(`${formatDate(start)} – ${formatDate(end)}`);
  else if (end) parts.push(`to ${formatDate(end)}`);
  const institution =
    parsed.format === "pdf"
      ? (parsed.pdf?.institution ?? null)
      : (parsed.ofx?.account.institution ?? null);
  const last4 = st?.account.last4 ?? null;
  const account = [institution, last4 ? `••${last4}` : null].filter(Boolean).join(" ");
  if (account) parts.push(account);
  return parts.join(" · ");
}
