import { Card } from "@stackd/ui";
import type { Category } from "../../data/db.ts";
import type { MonthTotals } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

const SHOWN = 6;

/** Out by category, biggest first, bars relative to the biggest; the rest folded into one row. */
export function CategoryBreakdown({
  totals,
  categories,
  averages,
  empty = "Nothing out this month yet.",
}: {
  totals: Pick<MonthTotals, "by_category">;
  categories: Map<string, Category>;
  /** Over a time range: each category's average a month, shown under its total. */
  averages?: Map<string | null, number>;
  empty?: string;
}) {
  const rows = totals.by_category;
  if (rows.length === 0) {
    return (
      <Card>
        <p>{empty}</p>
      </Card>
    );
  }
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.out_cents)));
  const shown = rows.slice(0, SHOWN);
  const rest = rows.slice(SHOWN);
  const restTotal = rest.reduce((sum, r) => sum + r.out_cents, 0);
  const name = (id: string | null) =>
    id ? (categories.get(id)?.name ?? "Unknown") : "Uncategorized";
  return (
    <Card as="section" aria-label="By category">
      {shown.map((r) => (
        <div className="cat-row" key={r.category_id ?? "none"}>
          <div className="cat-row__top">
            <span className="cat-row__name">{name(r.category_id)}</span>
            <span className="cat-row__amount">
              {formatCents(r.out_cents)}
              {averages?.has(r.category_id) ? (
                <span className="cat-row__avg">
                  {" "}
                  · {formatCents(averages.get(r.category_id) ?? 0)}/mo
                </span>
              ) : null}
            </span>
          </div>
          <div className="cat-row__bar" aria-hidden="true">
            <div
              className="cat-row__fill"
              style={{ width: `${Math.round((Math.max(0, r.out_cents) / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      {rest.length > 0 ? (
        <div className="cat-row cat-row--more">
          <div className="cat-row__top">
            <span className="cat-row__name">
              {rest.length} more {rest.length === 1 ? "category" : "categories"}
            </span>
            <span className="cat-row__amount">{formatCents(restTotal)}</span>
          </div>
          <div className="cat-row__bar" aria-hidden="true">
            <div
              className="cat-row__fill"
              style={{ width: `${Math.round((Math.max(0, restTotal) / max) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
