import { parseAmount, type SplitMethod } from "../../engine/bridge.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";

/** Typed per-person values → the rule's units: exact cents, percent bps, whole shares. */
export async function valuesOf(
  method: SplitMethod,
  people: string[],
  typed: Record<string, string>,
): Promise<Record<string, number> | null | "bad"> {
  if (method === "equal") return null;
  const out: Record<string, number> = {};
  for (const p of people) {
    const text = typed[p] ?? "";
    if (method === "shares") {
      const n = parseWholeNumber(text, 1, 1000);
      if (n === null) return "bad";
      out[p] = n;
    } else {
      // "$12.50" → 1250 cents; "33.33" percent → 3333 basis points (both two places).
      try {
        out[p] = await parseAmount(text.replace("%", ""));
      } catch {
        return "bad";
      }
    }
  }
  return out;
}
