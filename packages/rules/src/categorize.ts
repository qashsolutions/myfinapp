/**
 * Port of stackd_rules/categorize.py: user rules first, then the keyword table; substring
 * match on the cleaned description, first match wins. Nothing is guessed (owner decision,
 * October 28, 2026: no AI in the code, so the bundled learned model is gone): a description
 * neither table matches stays uncategorized for the person to sort.
 */

import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";

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

export function match(
  description: unknown,
  direction: unknown,
  userRules: unknown,
  keywords: unknown,
): MatchResult {
  if (direction !== "in" && direction !== "out") throw new RuleError("invalid_direction");
  const clean = cleanDescription(description);
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
  const isTransferHint = transferWords.some((w) => clean.includes(cleanDescription(w)));

  for (const rule of user) {
    if (typeof rule.category_id !== "string") throw new RuleError("invalid_rules");
    if (clean.includes(cleanDescription(rule.match))) {
      return {
        category_id: rule.category_id,
        matched_by: "user",
        is_transfer_hint: isTransferHint,
      };
    }
  }
  for (const entry of table) {
    const wanted = entry.direction === undefined ? "any" : entry.direction;
    if (wanted !== "in" && wanted !== "out" && wanted !== "any")
      throw new RuleError("invalid_keywords");
    if (wanted !== "any" && wanted !== direction) continue;
    if (clean.includes(cleanDescription(entry.match))) {
      if (typeof entry.category_id !== "string") throw new RuleError("invalid_keywords");
      return {
        category_id: entry.category_id,
        matched_by: "keyword",
        is_transfer_hint: isTransferHint,
      };
    }
  }
  return { category_id: null, matched_by: null, is_transfer_hint: isTransferHint };
}
