import "../auth/auth.css";
import "./cards.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import {
  engine,
  type PayoffOrder,
  type PayoffPlan as Plan,
  parseAmount,
  payoffPlan,
} from "../../engine/bridge.ts";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import {
  debtInputs,
  EXTRA_SETTING,
  ORDER_SETTING,
  PAYOFF_ORDERS,
  saveSetting,
  useDebtSettings,
} from "./debtPlan.ts";

export { EXTRA_SETTING, ORDER_SETTING };

const PRESETS = [0, 5000, 10000, 20000]; // suggestions; any amount works (owner sign-off, October 27, 2026)

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
 * balance first, October 28, 2026), both orders side by side, and what the extra buys against
 * minimums only. Nothing is moved; the plan is arithmetic on the numbers entered.
 */
export function PayoffPlan() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const settings = useDebtSettings();
  const [plans, setPlans] = useState<Record<PayoffOrder, Plan> | null>(null);
  const [baseline, setBaseline] = useState<Plan | null>(null);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings || settings.debts.length === 0) return;
    const { debts, extra, order } = settings;
    let alive = true;
    void (async () => {
      const input = debtInputs(debts);
      const [avalanche, snowball, minimums] = await Promise.all([
        payoffPlan(input, extra, today, "avalanche"),
        payoffPlan(input, extra, today, "snowball"),
        extra > 0 ? payoffPlan(input, 0, today, order) : null,
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
  }, [db, settings, today]);

  async function setExtra(cents: number) {
    setError(null);
    await saveSetting(db, EXTRA_SETTING, cents);
  }

  async function setCustomExtra() {
    try {
      const cents = await parseAmount(custom);
      if (cents < 0) throw new Error("negative");
      await setExtra(cents);
      setCustom("");
    } catch {
      setError("Enter an amount like 150.");
    }
  }

  if (!settings || settings.debts.length === 0) return null;
  const { extra, order } = settings;
  const plan = plans ? plans[order] : null;
  const sooner =
    plan && baseline && !plan.stalled && !baseline.stalled && extra > 0
      ? {
          months: (baseline.months ?? 0) - (plan.months ?? 0),
          interest: (baseline.total_interest_cents ?? 0) - (plan.total_interest_cents ?? 0),
        }
      : null;

  return (
    <Card as="section" aria-label="Payoff plan">
      <h2 className="sk-card__title">Payoff plan</h2>
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
          <p>
            {monthsText(plan.months ?? 0)} at {formatCents(plan.monthly_budget_cents)} a month ·{" "}
            {formatCents(plan.total_interest_cents ?? 0)} in interest.
            {sooner && (sooner.months > 0 || sooner.interest > 0)
              ? ` With ${formatCents(extra)} extra: ${monthsText(sooner.months)} sooner and ${formatCents(sooner.interest)} less interest than minimums only.`
              : ""}
          </p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 20 }}>
            {plan.order.map((d) => (
              <li key={d.id}>
                {d.label}: paid off {d.payoff_month ? formatMonth(`${d.payoff_month}-01`) : "now"}
                {d.interest_cents ? ` · ${formatCents(d.interest_cents)} interest` : ""}
              </li>
            ))}
          </ul>
          {plan.series_cents.length > 1 ? (
            <svg
              viewBox={`0 0 ${Math.max(plan.series_cents.length, 2)} 40`}
              preserveAspectRatio="none"
              width="100%"
              height="40"
              role="img"
              aria-label={`Total balance falling to zero over ${monthsText(plan.months ?? 0)}`}
            >
              <polyline
                fill="none"
                stroke="var(--c-a1)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                points={[plan.series_cents[0] ?? 0, ...plan.series_cents]
                  .map((v, i) => `${i},${40 - (40 * v) / Math.max(1, plan.series_cents[0] ?? 1)}`)
                  .join(" ")}
              />
            </svg>
          ) : null}
        </>
      )}
      <fieldset className="kind-chips" style={{ border: 0, margin: "8px 0 0", padding: 0 }}>
        <legend className="auth__label">Which debt gets the extra first</legend>
        {PAYOFF_ORDERS.map((o) => (
          <label className="chip-option" key={o.value}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-order`}
              value={o.value}
              checked={order === o.value}
              onChange={() => void saveSetting(db, ORDER_SETTING, o.value)}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      {plans ? (
        <ul className="order-compare" aria-label="Both orders side by side">
          {PAYOFF_ORDERS.map((o) => {
            const p = plans[o.value];
            return (
              <li
                key={o.value}
                className={`order-compare__item${order === o.value ? " order-compare__item--on" : ""}`}
              >
                <span className="order-compare__label">{o.label}</span>
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
      <fieldset className="kind-chips" style={{ border: 0, margin: "8px 0 0", padding: 0 }}>
        <legend className="auth__label">Extra each month, on top of the minimums</legend>
        {PRESETS.map((cents) => (
          <label className="chip-option" key={cents}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-extra`}
              value={cents}
              checked={extra === cents}
              onChange={() => void setExtra(cents)}
            />
            {cents === 0 ? "Minimums only" : `+${formatCents(cents)}`}
          </label>
        ))}
      </fieldset>
      <div className="transfer-choice" style={{ gridTemplateColumns: "1fr auto", marginTop: 8 }}>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="Other amount"
          aria-label="Other extra amount each month"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <Button variant="secondary" onClick={setCustomExtra}>
          Use
        </Button>
      </div>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="sk-card__eyebrow">
        Interest is estimated month by month from each balance and rate; your statements decide the
        real figures. Nothing is moved, and nothing here is financial advice.
      </p>
    </Card>
  );
}
