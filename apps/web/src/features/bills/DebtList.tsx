import "../groups/groups.css";

import { Card, Illustration } from "@stackd/ui";
import { useEffect, useState } from "react";
import type { Debt } from "../../data/db.ts";
import { type AvalancheOrder, avalancheOrder, payoffPlan } from "../../engine/bridge.ts";
import { formatCents, todayIso } from "../../lib/format.ts";
import { debtInputs, useDebtSettings } from "./debtPlan.ts";

export function aprText(bps: number): string {
  return `${(bps / 100).toFixed(2)}% APR`;
}

/** Cards and loans in the order the person picked (mockup F5Bills; highest rate first unless
 * they chose smallest balance first): the top one is where extra payments go. */
export function DebtList({ onEdit }: { onEdit: (debt: Debt) => void }) {
  const settings = useDebtSettings();
  const debts = settings?.debts;
  const kind = settings?.order ?? "avalanche";
  const [order, setOrder] = useState<AvalancheOrder | null>(null);
  useEffect(() => {
    if (!debts) return;
    let alive = true;
    void (async () => {
      const totals = await avalancheOrder(debts);
      if (kind === "snowball" && debts.length > 0) {
        // The same rule's own order, so the list and the plan never disagree.
        const plan = await payoffPlan(debtInputs(debts), 0, todayIso(), "snowball");
        const byId = new Map(totals.order.map((d) => [d.id, d]));
        totals.order = plan.order.flatMap((p) => {
          const d = byId.get(p.id);
          return d ? [{ ...d, rank: p.rank }] : [];
        });
      }
      if (alive) setOrder(totals);
    })();
    return () => {
      alive = false;
    };
  }, [debts, kind]);
  const byId = new Map((debts ?? []).map((d) => [d.id, d]));
  return (
    <>
      {order && order.order.length === 0 ? (
        <Card>
          <Illustration name="card" tone="a3" />
          <p>
            No cards or loans yet. Add each one with its balance, APR and minimum payment, and the
            app orders them by highest APR: pay minimums on all, extra on the first. Nothing is
            moved for you.
          </p>
        </Card>
      ) : null}
      {order && order.order.length > 0 ? (
        <p className="group-row__meta">
          Balances {formatCents(order.total_balance_cents)} · minimums{" "}
          {formatCents(order.total_min_payment_cents)} a month
        </p>
      ) : null}
      <ol
        className="lb"
        aria-label={
          kind === "snowball" ? "Debts, smallest balance first" : "Debts, highest APR first"
        }
      >
        {order?.order.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="card-link"
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                border: 0,
                padding: 0,
              }}
              onClick={() => {
                const row = byId.get(d.id);
                if (row) onEdit(row);
              }}
              aria-label={`${d.label}, ${aprText(d.apr_bps)}, balance ${formatCents(d.balance_cents)}, rank ${d.rank}`}
            >
              <Card as="div" className={d.rank === 1 ? "suggestion" : undefined}>
                <div className="goal-card__top">
                  <span className="lb__name">
                    <span className="lb__avatar" aria-hidden="true">
                      {d.rank}
                    </span>
                    <span>{d.label}</span>
                  </span>
                  <span className="lb__pct">{formatCents(d.balance_cents)}</span>
                </div>
                <p className="group-row__meta">
                  {aprText(d.apr_bps)} · min {formatCents(d.min_payment_cents)}
                  {d.rank === 1 ? " · extra payments go here" : ""}
                </p>
              </Card>
            </button>
          </li>
        ))}
      </ol>
      {order && order.order.length > 0 ? (
        <p className="auth__fineprint">
          {kind === "snowball"
            ? "Smallest balance first, so a debt is cleared sooner. Education, not advice."
            : "Avalanche order: highest APR first, so interest costs the least. Education, not advice."}
        </p>
      ) : null}
    </>
  );
}
