/**
 * Port of stackd_rules/categorize.py: user rules first, then the keyword table. A rule or
 * keyword matches as a whole word (`containsWord`) in the cleaned description or in its
 * merchant key; the longest match wins, ties by order (October 29, 2026, invariant 50).
 * Transfer words stay a plain substring. Nothing is guessed (owner decision, October 28, 2026:
 * no AI in the code, so the bundled learned model is gone): a description neither table
 * matches stays uncategorized for the person to sort.
 */

import { RuleError } from "./errors.ts";
import { cleanDescription, merchantKey } from "./fingerprint.ts";
import { containsWord } from "./recurring.ts";

export interface MatchResult {
  category_id: string | null;
  matched_by: "user" | "keyword" | null;
  is_transfer_hint: boolean;
}

interface RuleLike {
  match: string;
  category_id?: unknown;
  direction?: unknown;
}

function rules(value: unknown, code: string): RuleLike[] {
  if (!Array.isArray(value)) throw new RuleError(code);
  for (const rule of value) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      typeof (rule as RuleLike).match !== "string" ||
      (rule as RuleLike).match === ""
    ) {
      throw new RuleError(code);
    }
  }
  return value as RuleLike[];
}

/** The category of the longest pattern found as a whole word; ties go to the earlier one. */
function longest(clean: string, key: string, patterns: Array<[string, string]>): string | null {
  let best: [number, string] | null = null;
  for (const [pattern, category] of patterns) {
    const pClean = cleanDescription(pattern);
    const hit = containsWord(clean, pClean) || containsWord(key, merchantKey(pattern));
    const length = Array.from(pClean).length; // code points, as Python's len
    if (hit && (best === null || length > best[0])) best = [length, category];
  }
  return best === null ? null : best[1];
}

export function match(
  description: unknown,
  direction: unknown,
  userRules: unknown,
  keywords: unknown,
): MatchResult {
  if (direction !== "in" && direction !== "out") throw new RuleError("invalid_direction");
  const clean = cleanDescription(description);
  const key = merchantKey(description);
  const user = rules(userRules, "invalid_rules");
  if (typeof keywords !== "object" || keywords === null || Array.isArray(keywords)) {
    throw new RuleError("invalid_keywords");
  }
  const kw = keywords as { transfer?: unknown; keywords?: unknown };
  // Python's dict.get(key, []): the fallback only when the key is left out, never for null.
  const transferWords = kw.transfer === undefined ? [] : kw.transfer;
  const table = rules(kw.keywords === undefined ? [] : kw.keywords, "invalid_keywords");
  if (!Array.isArray(transferWords) || !transferWords.every((w) => typeof w === "string")) {
    throw new RuleError("invalid_keywords");
  }
  for (const rule of user) {
    if (typeof rule.category_id !== "string") throw new RuleError("invalid_rules");
  }
  const wantedTable: Array<[string, string]> = [];
  for (const entry of table) {
    const wanted = entry.direction === undefined ? "any" : entry.direction;
    if (wanted !== "in" && wanted !== "out" && wanted !== "any")
      throw new RuleError("invalid_keywords");
    if (typeof entry.category_id !== "string") throw new RuleError("invalid_keywords");
    if (wanted === "any" || wanted === direction)
      wantedTable.push([entry.match, entry.category_id]);
  }
  const isTransferHint = transferWords.some((w) => clean.includes(cleanDescription(w)));

  const own = longest(
    clean,
    key,
    user.map((r) => [r.match, r.category_id as string]),
  );
  if (own !== null)
    return { category_id: own, matched_by: "user", is_transfer_hint: isTransferHint };
  const found = longest(clean, key, wantedTable);
  if (found !== null)
    return { category_id: found, matched_by: "keyword", is_transfer_hint: isTransferHint };
  return { category_id: null, matched_by: null, is_transfer_hint: isTransferHint };
}
