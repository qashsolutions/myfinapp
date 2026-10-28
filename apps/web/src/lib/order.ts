/**
 * One way to order text in the app (October 27, 2026), the same as the engine: by code point,
 * never `localeCompare`, whose answer depends on the phone's language. Dates, timestamps and ids
 * sort with `compareText`; names people read sort with `byLabel` (A and a together, then the
 * exact text so the order is always total).
 */
import { compareText } from "@stackd/rules/text";

export { compareText };

export function byLabel(a: string, b: string): number {
  return compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b);
}
