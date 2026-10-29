import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { formatMonth } from "../../lib/format.ts";
import { useDebtFreePlan } from "../bills/debtPlan.ts";

/**
 * Home's Debt-free card (October 28, 2026): the month the person's debts are paid off at their
 * extra and order, straight from `bills.payoff_plan`. Hidden with no debts; "Stalled" when the
 * payments never catch the interest. Opens Bills → Debt payoff.
 */
export function DebtFreeCard({ today }: { today: string }) {
  const plan = useDebtFreePlan(today);
  if (!plan) return null;
  return (
    <Link to="/bills?tab=debt" className="card-link" aria-label="Open Debt payoff">
      <Card as="section" aria-labelledby="home-debt-free">
        <h2 className="sk-card__title" id="home-debt-free">
          Debt payoff
        </h2>
        {plan.stalled ? (
          <>
            <Word>Stalled</Word>
            <p className="sk-card__eyebrow">Payments don't catch the interest yet</p>
          </>
        ) : (
          <>
            <Word>Debt-free</Word>
            <p className="sk-card__eyebrow">
              {plan.debt_free_month ? `by ${formatMonth(`${plan.debt_free_month}-01`)}` : "now"}
            </p>
          </>
        )}
      </Card>
    </Link>
  );
}
