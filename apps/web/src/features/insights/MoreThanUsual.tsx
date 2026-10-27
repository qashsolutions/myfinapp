import "./insights.css";

import { Card } from "@stackd/ui";
import type { Category } from "../../data/db.ts";
import { formatCents } from "../../lib/format.ts";
import { cardText } from "../../moments/catalog.ts";
import { useMoreThanUsual } from "./useInsights.ts";

/**
 * "More than usual" (fast-follow 8): categories running above the same days of recent months.
 * A fact about the user's own spending, not advice; hidden until there is something to say.
 */
export function MoreThanUsual({
  asOf,
  categories,
}: {
  asOf: string;
  categories: Map<string, Category>;
}) {
  const result = useMoreThanUsual(asOf);
  if (!result || result.flagged.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="more-than-usual-h">
      <h2 className="sk-card__title" id="more-than-usual-h">
        Running higher than usual
      </h2>
      <ul className="insight__list">
        {result.flagged.slice(0, 3).map((f) => (
          <li key={f.category_id} className="insight__row">
            <span>
              {categories.get(f.category_id)?.name ?? "A category"}
              <span className="insight__sub">
                {formatCents(f.current_cents)} so far vs about {formatCents(f.usual_cents)} by this
                point
              </span>
            </span>
            <strong>+{formatCents(f.increase_cents)}</strong>
          </li>
        ))}
      </ul>
      <p className="insight__kind">
        {cardText("spending_up", {}, result.flagged[0]?.category_id ?? "")}
      </p>
      <p className="auth__fineprint">
        Compared with the same days of your last{" "}
        {result.months_used === 1 ? "month" : `${result.months_used} months`} with entries.
      </p>
    </Card>
  );
}
