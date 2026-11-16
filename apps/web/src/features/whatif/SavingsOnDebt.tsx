import { Card, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AmountSlider } from "../../app/layout/AmountSlider.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type DebtInput,
  type PayoffOrder,
  type WhatIfLumpSum,
  whatIfLumpSum,
} from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { GROUP_LABEL, useNetWorth, type WorthRow } from "../networth/useNetWorth.ts";
import { AmountChoice, DebtResult } from "./WhatIfScreen.tsx";

/**
 * Use savings on debt (owner decision, November 16, 2026): one payment today from what the person
 * owns, down the payoff plan's order, through `whatif.lump_sum`. Cash and investments count by
 * default; retirement, home, car and other are off until they turn them on, and each account
 * has its own switch. Nothing is moved: an illustration, not advice.
 */
export const COUNTS_SETTING = "whatif.savings_counts";

/** Counted unless the person says otherwise: money reachable within days. */
const COUNT_BY_DEFAULT = new Set(["cash", "savings", "investments"]);

export function countsByDefault(row: Pick<WorthRow, "group">): boolean {
  return COUNT_BY_DEFAULT.has(row.group);
}

export function SavingsOnDebt({
  debts,
  extra,
  order,
  today,
  amount,
  onAmount,
}: {
  debts: DebtInput[];
  extra: number;
  order: PayoffOrder;
  today: string;
  amount: number;
  onAmount: (cents: number) => void;
}) {
  const { db } = useDb();
  const worth = useNetWorth(today);
  const saved = useLiveQuery(
    async () =>
      ((await db.settings.get(COUNTS_SETTING))?.value as Record<string, boolean> | undefined) ?? {},
    [db],
  );
  const [result, setResult] = useState<WhatIfLumpSum | null>(null);

  const owned = worth.rows.filter(
    (r) => r.kind === "asset" && r.included && (r.valueCents ?? 0) > 0,
  );
  const counts = (r: WorthRow) => saved?.[r.key] ?? countsByDefault(r);
  const counted = owned.filter(counts).reduce((n, r) => n + (r.valueCents ?? 0), 0);
  const owed = debts.reduce((n, d) => n + d.balance_cents, 0);
  const retirement = owned.some((r) => counts(r) && r.group === "retirement");
  const tooMuch = amount > counted;

  useEffect(() => {
    if (!debts.length || amount <= 0 || amount > counted) {
      setResult(null);
      return;
    }
    let alive = true;
    void whatIfLumpSum(debts, extra, amount, today, order)
      .then((r) => {
        if (alive) setResult(r);
      })
      .catch(() => {
        if (alive) setResult(null);
      });
    return () => {
      alive = false;
    };
  }, [debts, extra, amount, today, order, counted]);

  async function setCount(row: WorthRow, on: boolean) {
    await db.settings.put({
      key: COUNTS_SETTING,
      value: { ...(saved ?? {}), [row.key]: on },
      updated_at: new Date().toISOString(),
    });
  }

  const label = (id: string) => debts.find((d) => d.id === id)?.label ?? "a debt";
  const applied = result?.applied ?? [];
  const presets = [100000, 500000, counted].filter(
    (c, i, all) => c > 0 && c <= counted && all.indexOf(c) === i,
  );

  return (
    <>
      {result ? (
        <>
          <DebtResult
            r={result}
            label={null}
            planExtra={extra}
            add={amount}
            afterLabel={`Using ${formatCents(amount)} of savings today`}
          />
          <p className="whatif-savings__applied">
            {applied
              .map((a) =>
                a.cents >=
                (debts.find((d) => d.id === a.id)?.balance_cents ?? Number.MAX_SAFE_INTEGER)
                  ? `Clears ${label(a.id)}`
                  : `${formatCents(a.cents)} on ${label(a.id)}`,
              )
              .join(" · ")}
            {result.unused_cents > 0
              ? ` · ${formatCents(result.unused_cents)} more than you owe`
              : ""}
            . Leaves {formatCents(Math.max(0, counted - amount))} of what you counted.
          </p>
        </>
      ) : null}
      <Card as="section" aria-label="Use savings on debt">
        <h2 className="sk-card__title">Use savings on debt</h2>
        {owned.length === 0 ? (
          <p>
            Add what you own on <Link to="/net-worth">Net worth</Link> first: an account, savings or
            investments.
          </p>
        ) : (
          <>
            <p className="sk-card__eyebrow">
              One payment today, highest {order === "snowball" ? "smallest balance" : "rate"} first.
              You owe {formatCents(owed)}; you counted {formatCents(counted)}.
            </p>
            <AmountSlider
              label="Use"
              suffix="today"
              value={Math.min(amount, Math.max(counted, 0))}
              min={0}
              step={5000}
              max={Math.max(counted, 5000)}
              onChange={onAmount}
            />
            {presets.length ? (
              <AmountChoice
                legend="How much to use"
                presets={presets}
                value={amount}
                onChange={onAmount}
                plus={false}
              />
            ) : null}
            {tooMuch ? (
              <p className="auth__error" role="alert">
                That's more than the {formatCents(counted)} you counted. Count more below, or use
                less.
              </p>
            ) : null}
            <h3 className="auth__label">What counts</h3>
            <ul className="whatif-savings__list">
              {owned.map((r) => (
                <li key={r.key}>
                  <span className="whatif-savings__name">
                    {r.label}
                    <span className="whatif-savings__kind">
                      {GROUP_LABEL[r.group] ?? r.group} · {formatCents(r.valueCents ?? 0)}
                    </span>
                  </span>
                  <Toggle
                    label={`Count ${r.label}`}
                    checked={counts(r)}
                    onChange={(on) => void setCount(r, on)}
                  />
                </li>
              ))}
            </ul>
            {retirement ? (
              <p className="sk-card__eyebrow" role="note">
                Retirement money usually costs tax and a penalty if taken out early.
              </p>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
