import "./visuals.css";

import { trimSpaces } from "@stackd/rules/text";
import { Button, Sheet } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import {
  type DebtInput,
  type PayoffOrder,
  type PayoffPlan,
  parseAmount,
  payoffPlan,
} from "../../engine/bridge.ts";
import { formatCents, formatCentsTidy, formatMonthShort } from "../../lib/format.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { EXTRA_SETTING, ORDER_SETTING, PAYOFF_ORDERS, saveSetting } from "./debtPlan.ts";
import { PayoffChart } from "./PayoffChart.tsx";

/** Suggested extras; any amount works (owner sign-off, October 27, 2026). */
export const EXTRA_PRESETS = [0, 5000, 10000, 20000];
/** The slider reaches $500, or twice the saved extra when that is more, in $10 steps. */
const SLIDER_FLOOR = 50000;
const SLIDER_STEP = 1000;

/** "$1,250" or "1250.50" as typed: the engine reads the amount, this only screens the shape. */
const AMOUNT_SHAPE = /^\$?[0-9][0-9,]*(\.[0-9]{0,2})?$/;

/**
 * The extra each month as suggestions plus the person's own amount, with a slider beside them
 * for trying values out (October 29, 2026). Chip values carry a `c:` prefix and typed ones `t:`,
 * so a typed "5000" (dollars) is never read as the 5000-cent chip.
 */
export function ExtraPicker({
  value,
  onChange,
  sliderMax,
}: {
  value: number;
  onChange: (cents: number) => void;
  sliderMax: number;
}) {
  const ids = useId();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <ChipsOrOwn
        name={`${ids}-extra`}
        legend="Extra each month, on top of the minimums"
        options={EXTRA_PRESETS.map((c) => [
          `c:${c}`,
          c === 0 ? "Minimums only" : `+${formatCentsTidy(c)}`,
        ])}
        value={`c:${value}`}
        display={(v) => (v.startsWith("c:") ? (Number(v.slice(2)) / 100).toFixed(2) : v.slice(2))}
        onPick={(v) => {
          setProblem(null);
          if (v.startsWith("c:")) {
            onChange(Number(v.slice(2)));
            return;
          }
          void parseAmount(v.slice(2))
            .then((cents) => {
              if (cents < 0) throw new Error("negative");
              onChange(cents);
            })
            .catch(() => setProblem("Enter an amount like 150."));
        }}
        own={{
          label: "Other extra amount each month",
          placeholder: "Other amount",
          inputMode: "decimal",
          parse: (text) => {
            const t = trimSpaces(text);
            return AMOUNT_SHAPE.test(t)
              ? { value: `t:${t}` }
              : { error: "Enter an amount like 150." };
          },
        }}
      />
      {problem ? (
        <p className="auth__error" role="alert">
          {problem}
        </p>
      ) : null}
      <label className="adjust-slider">
        <span>
          Try an amount <span className="adjust-slider__value">{formatCents(value)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={sliderMax}
          step={SLIDER_STEP}
          value={Math.min(value, sliderMax)}
          aria-valuetext={`${formatCents(value)} extra a month`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    </>
  );
}

export function sliderMaxFor(saved: number): number {
  return Math.max(SLIDER_FLOOR, Math.ceil((saved * 2) / SLIDER_STEP) * SLIDER_STEP);
}

/**
 * "Adjust payoff plan" (October 29, 2026): the order and the extra, with the timeline redrawn
 * live from `bills.payoff_plan` as either changes. Nothing is saved until "Use these".
 */
export function AdjustPayoffSheet({
  open,
  onClose,
  debts,
  startCents,
  extra,
  order,
  asOf,
}: {
  open: boolean;
  onClose: () => void;
  debts: DebtInput[];
  startCents: number | null;
  extra: number;
  order: PayoffOrder;
  asOf: string;
}) {
  const { db } = useDb();
  const ids = useId();
  const [draftExtra, setDraftExtra] = useState(extra);
  const [draftOrder, setDraftOrder] = useState<PayoffOrder>(order);
  const [plans, setPlans] = useState<Record<PayoffOrder, PayoffPlan> | null>(null);
  const [sliderMax, setSliderMax] = useState(sliderMaxFor(extra));

  // Each opening starts from what is saved.
  useEffect(() => {
    if (!open) return;
    setDraftExtra(extra);
    setDraftOrder(order);
    setSliderMax(sliderMaxFor(extra));
  }, [open, extra, order]);

  useEffect(() => {
    if (!open || debts.length === 0) return;
    let alive = true;
    void Promise.all([
      payoffPlan(debts, draftExtra, asOf, "avalanche"),
      payoffPlan(debts, draftExtra, asOf, "snowball"),
    ])
      .then(([avalanche, snowball]) => {
        if (alive) setPlans({ avalanche, snowball });
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [open, debts, draftExtra, asOf]);

  async function use() {
    await saveSetting(db, EXTRA_SETTING, draftExtra);
    await saveSetting(db, ORDER_SETTING, draftOrder);
    onClose();
  }

  const plan = plans?.[draftOrder] ?? null;
  const otherOrder: PayoffOrder = draftOrder === "avalanche" ? "snowball" : "avalanche";
  return (
    <Sheet open={open} onClose={onClose} title="Adjust payoff plan">
      <div role="status" aria-live="polite">
        {plan === null ? null : plan.stalled ? (
          <>
            <Word>Stalled</Word>
            <p className="sk-card__eyebrow">Payments don't catch the interest yet</p>
          </>
        ) : (
          <>
            <p className="sk-card__hero sk-card__hero--empty">
              {plan.debt_free_month ? formatMonthShort(plan.debt_free_month) : "Now"}
            </p>
            <p className="sk-card__eyebrow">
              Debt-free at this pace · {formatCents(plan.total_interest_cents ?? 0)} interest
            </p>
          </>
        )}
      </div>
      {plan && startCents ? (
        <PayoffChart
          plan={plan}
          other={plans?.[otherOrder] ?? null}
          startCents={startCents}
          otherLabel={PAYOFF_ORDERS.find((o) => o.value === otherOrder)?.label}
        />
      ) : null}
      <fieldset className="kind-chips" style={{ border: 0, margin: "12px 0 0", padding: 0 }}>
        <legend className="auth__label">Which debt gets the extra first</legend>
        {PAYOFF_ORDERS.map((o) => (
          <label className="chip-option" key={o.value}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-order`}
              value={o.value}
              checked={draftOrder === o.value}
              onChange={() => setDraftOrder(o.value)}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      <p className="auth__hint">{PAYOFF_ORDERS.find((o) => o.value === draftOrder)?.line}</p>
      <ExtraPicker value={draftExtra} onChange={setDraftExtra} sliderMax={sliderMax} />
      <div className="adjust-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void use()}>Use these</Button>
      </div>
    </Sheet>
  );
}
