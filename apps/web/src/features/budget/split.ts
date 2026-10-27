/** Your own needs / wants / save split (owner, October 20, 2026: 50/30/20 is our suggestion, the
 * person decides). Whole percentages on screen; basis points in the budget row and the engine. */
export interface Split {
  need: number;
  want: number;
  save: number;
}

export const SUGGESTED: Split = { need: 5000, want: 3000, save: 2000 };

/** "50/30/20", "60/25/15". */
export function splitLabel(split: Split | null | undefined): string {
  const s = split ?? SUGGESTED;
  return [s.need, s.want, s.save].map((bps) => Math.round(bps / 100)).join("/");
}

/** Whole-percent text from three boxes → a split, or null until they are whole numbers adding to 100. */
export function splitFromPercents(need: string, want: string, save: string): Split | null {
  const parts = [need, want, save].map((t) =>
    /^\d{1,3}$/.test(t.trim()) ? Number(t.trim()) : NaN,
  );
  if (parts.some((p) => Number.isNaN(p) || p > 100)) return null;
  const [n = 0, w = 0, s = 0] = parts;
  if (n + w + s !== 100) return null;
  return { need: n * 100, want: w * 100, save: s * 100 };
}
