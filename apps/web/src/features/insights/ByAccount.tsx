import "./insights.css";

import { Card } from "@stackd/ui";
import type { Account } from "../../data/db.ts";
import type { MonthTotals } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { accountLabel } from "../entries/useEntries.ts";

/** Spending per account and card this month (fast-follow 8), from the month totals already computed. */
export function ByAccount({
  totals,
  accounts,
}: {
  totals: MonthTotals;
  accounts: Map<string, Account>;
}) {
  const rows = totals.by_account
    .filter((a) => a.out_cents > 0)
    .sort((a, b) => b.out_cents - a.out_cents || (a.account_id < b.account_id ? -1 : 1));
  if (rows.length < 2) return null; // one account says nothing the totals don't
  return (
    <Card as="section" aria-labelledby="by-account-h">
      <h2 className="sk-card__title" id="by-account-h">
        Spending by account
      </h2>
      <ul className="insight__list">
        {rows.map((a) => (
          <li key={a.account_id} className="insight__row">
            <span>{accountLabel(accounts.get(a.account_id))}</span>
            <strong>{formatCents(a.out_cents)}</strong>
          </li>
        ))}
      </ul>
      <p className="auth__fineprint">Money out this month, transfers between accounts excluded.</p>
    </Card>
  );
}
