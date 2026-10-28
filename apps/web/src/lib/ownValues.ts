/**
 * Values people type instead of a suggested choice (owner, October 27, 2026: every picker
 * suggests, and every picker also takes the person's own value). Whole numbers only; amounts
 * still go through `engine/bridge.parseAmount`.
 */
import { trimSpaces } from "@stackd/rules/text";

/** "14" → 14 when it is a whole number from `min` to `max`, else null. */
export function parseWholeNumber(text: string, min: number, max: number): number | null {
  const t = trimSpaces(text);
  if (!/^[0-9]{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

export const MAX_CHECKPOINTS = 5;

/**
 * "10, 50, 90" (or "10 50 90%") → basis points [1000, 5000, 9000]: whole percents from 1 to 99,
 * repeats dropped, in order, at most `MAX_CHECKPOINTS`. Null when anything else is typed.
 */
export function parseCheckpoints(text: string): number[] | null {
  const parts = trimSpaces(text)
    .split(/[,;%\s]+/)
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const out = new Set<number>();
  for (const p of parts) {
    const n = parseWholeNumber(p, 1, 99);
    if (n === null) return null;
    out.add(n * 100);
  }
  if (out.size > MAX_CHECKPOINTS) return null;
  return [...out].sort((a, b) => a - b);
}

/** [2500, 5000, 7500] → "25%, 50%, 75%". */
export function checkpointsText(bps: number[]): string {
  return bps.map((b) => `${b / 100}%`).join(", ");
}
