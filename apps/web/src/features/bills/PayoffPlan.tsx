import "../auth/auth.css";
import "./cards.css";
import "./visuals.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useMemo, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import {
  engine,
  type PayoffOrder,
  type PayoffPlan as Plan,
  payoffPlan,
} from "../../engine/bridge.ts";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { AdjustPayoffSheet } from "./AdjustPayoff.tsx";
import {
  debtInputs,
  EXTRA_SETTING,
  ORDER_SETTING,
  PAYOFF_ORDERS,
  useDebtSettings,
  useDebtTotal,
} from "./debtPlan.ts";
import { PayoffChart } from "./PayoffChart.tsx";

export { EXTRA_SETTING, ORDER_SETTING };

function monthsText(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}

function monthText(plan: Plan): string {
  return plan.debt_free_month ? formatMonth(`${plan.debt_free_month}-01`) : "now";
}

/**
 * The debt payoff planner (fast-follow 1; docs/spec.md "Rules added for the debt payoff
 * planner"): a fixed monthly budget of every minimum plus an extra amount, month by month from
 * the `bills.payoff_plan` rule in the order the person picks (highest rate first or smallest
 * balance first, October 28, 2026). Since October 29, 2026 it leads with the payoff timeline
 * (the total falling to zero, each debt's payoff month marked, the other order dashed), both
 * orders side by side, and an Adjust sheet for the extra and the order. Nothing is moved; the
 * plan is arithmetic on the numbers entered.
 */
export function PayoffPlan() {
  const { db } = useDb();
  const today = todayIso();
  const settings = useDebtSettings();
  const start = useDebtTotal();
  const [plans, setPlans] = useState<Record<PayoffOrder, Plan> | null>(null);
  const [baseline, setBaseline] = useState<Plan | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const inputs = useMemo(() => (settings ? debtInputs(settings.debts) : []), [settings]);

  useEffect(() => {
    if (!settings || settings.debts.length === 0) return;
    const { extra, order } = settings;
    let alive = true;
    void (async () => {
      const [avalanche, snowball, minimums] = await Promise.all([
        payoffPlan(inputs, extra, today, "avalanche"),
        payoffPlan(inputs, extra, today, "snowball"),
        extra > 0 ? payoffPlan(inputs, 0, today, order) : null,
      ]);
      if (!alive) return;
      const chosen = order === "snowball" ? snowball : avalanche;
      setPlans({ avalanche, snowball });
      setBaseline(minimums ?? chosen);
      await db.computed_results.put({
        id: `payoff_plan:${today}`,
        kind: "payoff_plan",
        as_of: today,
        rules_version: engine.rulesVersion ?? "unknown",
        payload: { extra_cents: extra, ...chosen, payoff_order: order },
        computed_at: new Date().toISOString(),
      });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [db, settings, inputs, today]);

  if (!settings || settings.debts.length === 0) return null;
  const { extra, order } = settings;
  const plan = plans ? plans[order] : null;
  const otherOrder: PayoffOrder = order === "avalanche" ? "snowball" : "avalanche";
  const sooner =
    plan && baseline && !plan.stalled && !baseline.stalled && extra > 0
      ? {
          months: (baseline.months ?? 0) - (plan.months ?? 0),
          interest: (baseline.total_interest_cents ?? 0) - (plan.total_interest_cents ?? 0),
        }
      : null;

  return (
    <Card as="section" aria-label="Payoff plan">
      <div className="adjust-head">
        <h2 className="sk-card__title">Payoff plan</h2>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Adjust payoff plan"
          onClick={() => setAdjusting(true)}
        >
          Adjust
        </Button>
      </div>
      {plan === null ? (
        <p className="sr-only">Working it out</p>
      ) : plan.stalled ? (
        <>
          <Word>Stalled</Word>
          <p role="status">
            At these minimums the balances grow instead of shrinking. Add an extra amount each month
            to make a plan.
          </p>
        </>
      ) : (
        <>
          {/* The month leads as the value; "Debt-free" is what it means, at this pace. */}
          <p className="sk-card__hero sk-card__hero--empty" role="status">
            {plan.debt_free_month ? monthText(plan) : "Now"}
          </p>
          <p className="sk-card__eyebrow">
            {plan.debt_free_month ? "Debt-free at this pace" : "No balance left"}
          </p>
          {start ? (
            <PayoffChart
              plan={plan}
              other={plans?.[otherOrder] ?? null}
              startCents={start}
              otherLabel={PAYOFF_ORDERS.find((o) => o.value === otherOrder)?.label}
            />
          ) : null}
          <p>
            {monthsText(plan.months ?? 0)} at {formatCents(plan.monthly_budget_cents)} a month ·{" "}
            {formatCents(plan.total_interest_cents ?? 0)} in interest.
            {sooner && (sooner.months > 0 || sooner.interest > 0)
              ? ` With ${formatCents(extra)} extra: ${monthsText(sooner.months)} sooner and ${formatCents(sooner.interest)} less interest than minimums only.`
              : extra === 0
                ? " Minimums only."
                : ""}
          </p>
          <ul className="sr-only" aria-label="Each debt">
            {plan.order.map((d) => (
              <li key={d.id}>
                {d.label}: paid off {d.payoff_month ? formatMonth(`${d.payoff_month}-01`) : "now"}
                {d.interest_cents ? ` · ${formatCents(d.interest_cents)} interest` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {plans ? (
        <ul className="order-compare" aria-label="Both orders side by side">
          {PAYOFF_ORDERS.map((o) => {
            const p = plans[o.value];
            return (
              <li
                key={o.value}
                className={`order-compare__item${order === o.value ? " order-compare__item--on" : ""}`}
              >
                <span className="order-compare__label">
                  {o.label}
                  {order === o.value ? <span className="sr-only"> (your order)</span> : null}
                </span>
                <span className="order-compare__value">
                  {p.stalled ? "No end at this amount" : `Debt-free ${monthText(p)}`}
                </span>
                <span className="order-compare__value">
                  {p.stalled ? "—" : `${formatCents(p.total_interest_cents ?? 0)} interest`}
                </span>
                <span className="order-compare__line">{o.line}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="sk-card__eyebrow">
        Interest is estimated month by month from each balance and rate; your statements decide the
        real figures. Nothing is moved, and nothing here is financial advice.
      </p>
      <AdjustPayoffSheet
        open={adjusting}
        onClose={() => setAdjusting(false)}
        debts={inputs}
        startCents={start ?? null}
        extra={extra}
        order={order}
        asOf={today}
      />
    </Card>
  );
}
