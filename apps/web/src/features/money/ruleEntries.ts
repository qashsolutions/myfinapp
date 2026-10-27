import type { Category, Entry } from "../../data/db.ts";
import type { RuleEntry } from "../../engine/bridge.ts";

/** The shape the cashflow rules take: an entry plus its category's kind. */
export function toRuleEntry(e: Entry, categories: Map<string, Category>): RuleEntry {
  const kind = e.category_id ? (categories.get(e.category_id)?.kind ?? null) : null;
  return {
    id: e.id,
    date: e.date,
    amount_cents: e.amount_cents,
    direction: e.direction,
    is_transfer: e.is_transfer,
    category_id: e.category_id,
    category_kind: kind,
    account_id: e.account_id,
  };
}
