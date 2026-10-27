import "./insights.css";

import { Card } from "@stackd/ui";
import { formatCents, formatDay, formatMonth } from "../../lib/format.ts";
import { useBiggerMonths } from "./useInsights.ts";

const EVERY: Record<string, string> = { quarterly: "every 3 months", yearly: "yearly" };

/**
 * Bigger months ahead (fast-follow 8): quarterly and yearly bills with an amount to set aside
 * each month, and months that ran high last year. Estimates from the user's own history.
 */
export function BiggerMonths({ asOf, labels }: { asOf: string; labels: Map<string, string> }) {
  const { lumpy, seasonal } = useBiggerMonths(asOf);
  const bills = lumpy?.bills ?? [];
  const spikes = seasonal?.flagged ?? [];
  if (bills.length === 0 && spikes.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="bigger-months-h">
      <h2 className="sk-card__title" id="bigger-months-h">
        Bigger months ahead
      </h2>
      {bills.length > 0 ? (
        <ul className="insight__list" aria-label="Bills that come less than monthly">
          {bills.map((b) => (
            <li key={`${b.payee}:${b.due_date}`} className="insight__row">
              <span>
                {labels.get(b.payee) ?? b.payee} · {formatCents(b.amount_cents)}
                <span className="insight__sub">
                  {EVERY[b.interval] ?? b.interval}, next {formatDay(b.due_date)}
                </span>
              </span>
              <strong>
                {b.months_to_save > 1
                  ? `Set aside ${formatCents(b.per_month_cents)} a month`
                  : "Due this month"}
              </strong>
            </li>
          ))}
        </ul>
      ) : null}
      {spikes.length > 0 ? (
        <ul className="insight__list" aria-label="Months that ran high last year">
          {spikes.map((s) => (
            <li key={s.month} className="insight__row">
              <span>
                {formatMonth(`${s.month}-01`)}
                <span className="insight__sub">
                  Last year you spent {formatCents(s.last_year_cents)}, about{" "}
                  {formatCents(s.usual_cents)} is a usual month
                </span>
              </span>
              <strong>+{formatCents(s.increase_cents)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="auth__fineprint">An estimate from your own history, not a prediction.</p>
    </Card>
  );
}
