import { Button, Card, Chip } from "@stackd/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { BudgetMethod, PayFrequency, PaySettings } from "../../data/db.ts";
import { budgetTargets, EngineError, monthlyTakeHome, parseAmount } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { type Split, SUGGESTED, splitFromPercents } from "./split.ts";
import { createBudget } from "./useBudget.ts";

const FREQUENCIES: Array<[PayFrequency, string]> = [
  ["weekly", "Weekly"],
  ["biweekly", "Every 2 weeks"],
  ["semimonthly", "Twice a month"],
  ["monthly", "Monthly"],
];

/**
 * Take-home pay (mockup F2Pay) then the budget style (F2Method), on the device. Used for the
 * first budget, "Edit take-home" and "Change budget style".
 */
export function BudgetSetup({
  month,
  step: initialStep = "pay",
  existing,
  onDone,
  onCancel,
}: {
  month: string;
  step?: "pay" | "method";
  existing?: {
    method: BudgetMethod;
    take_home_cents: number;
    id: string;
    split_bps?: Split | null;
  } | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const [step, setStep] = useState<"pay" | "method">(initialStep);
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<PayFrequency>("biweekly");
  const [nextPayday, setNextPayday] = useState("");
  const [monthly, setMonthly] = useState<number | null>(existing?.take_home_cents ?? null);
  const [method, setMethod] = useState<BudgetMethod>(existing?.method ?? "50_30_20");
  const [targets, setTargets] = useState<{ need: number; want: number; save: number } | null>(null);
  // Your own split, in whole percent; 50/30/20 is where it starts (October 20, 2026).
  const start = existing?.split_bps ?? SUGGESTED;
  const [pct, setPct] = useState({
    need: String(start.need / 100),
    want: String(start.want / 100),
    save: String(start.save / 100),
  });
  const split = useMemo(
    () => splitFromPercents(pct.need, pct.want, pct.save),
    [pct.need, pct.want, pct.save],
  );
  const total = [pct.need, pct.want, pct.save].reduce((sum, t) => sum + (Number(t) || 0), 0);
  const [error, setError] = useState<string | null>(null);

  // The saved pay fills the form once, and never over what the person has started typing
  // (invariant 18, October 27, 2026: it used to reload on every new monthly figure, which put
  // the old paycheck back while a new one was being typed).
  const touched = useRef(false);
  useEffect(() => {
    let alive = true;
    void db.settings.get("pay").then((row) => {
      const pay = row?.value as PaySettings | undefined;
      if (!alive || !pay || touched.current) return;
      setAmount((pay.amount_cents / 100).toFixed(2));
      setFrequency(pay.frequency);
      setNextPayday(pay.next_payday ?? "");
      setMonthly((m) => m ?? pay.monthly_cents);
    });
    return () => {
      alive = false;
    };
  }, [db]);

  useEffect(() => {
    let alive = true;
    const text = amount.trim();
    if (!text) {
      return;
    }
    void (async () => {
      try {
        const cents = await parseAmount(text);
        const m = await monthlyTakeHome(cents, frequency);
        if (alive) setMonthly(m);
      } catch {
        if (alive) setMonthly(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [amount, frequency]);

  useEffect(() => {
    if (monthly === null) return;
    let alive = true;
    if (!split) return;
    void budgetTargets(monthly, split).then((t) => {
      if (alive) setTargets(t);
    });
    return () => {
      alive = false;
    };
  }, [monthly, split]);

  async function continueFromPay() {
    setError(null);
    let cents: number;
    try {
      cents = await parseAmount(amount);
    } catch (err) {
      setError(
        err instanceof EngineError
          ? "Enter what you take home each paycheck, like 2600."
          : "Couldn't read that amount.",
      );
      return;
    }
    if (cents <= 0) {
      setError("Enter an amount above zero.");
      return;
    }
    const m = await monthlyTakeHome(cents, frequency);
    const pay: PaySettings = {
      amount_cents: cents,
      frequency,
      next_payday: nextPayday || null,
      monthly_cents: m,
    };
    await db.settings.put({ key: "pay", value: pay, updated_at: new Date().toISOString() });
    setMonthly(m);
    setStep("method");
  }

  async function finish() {
    if (monthly === null) return;
    if (method === "50_30_20" && !split) {
      setError("Make your three numbers add up to 100%.");
      return;
    }
    const stamp = new Date().toISOString();
    const splitBps = method === "50_30_20" ? split : null;
    if (existing) {
      await db.budgets.update(existing.id, {
        method,
        take_home_cents: monthly,
        split_bps: splitBps,
        updated_at: stamp,
      });
      if (method === "zero_based") await ensureLines(existing.id);
    } else {
      const budget = await createBudget(db, month, method, monthly, [], new Date(), splitBps);
      if (method === "zero_based") await ensureLines(budget.id);
    }
    onDone();
  }

  async function ensureLines(budgetId: string) {
    const have = new Set(
      (await db.budget_lines.where("budget_id").equals(budgetId).toArray()).map(
        (l) => l.category_id,
      ),
    );
    const expense = await db.categories.where("kind").equals("expense").sortBy("sort");
    const missing = expense.filter((c) => !have.has(c.id));
    if (missing.length) {
      await db.budget_lines.bulkAdd(
        missing.map((c) => ({
          id: crypto.randomUUID(),
          budget_id: budgetId,
          category_id: c.id,
          planned_cents: 0,
        })),
      );
    }
  }

  if (step === "pay") {
    return (
      <>
        <h2 className="auth__title">What do you take home?</h2>
        <p className="auth__lead">
          Your pay after tax. It stays on this device and powers your budget and forecast.
        </p>
        <div className="fields">
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-amount`}>
              Each paycheck
            </label>
            <input
              id={`${ids}-amount`}
              className="field__input"
              inputMode="decimal"
              placeholder="2,600.00"
              value={amount}
              onChange={(e) => {
                touched.current = true;
                setAmount(e.target.value);
              }}
            />
          </div>
          <fieldset className="pay-freqs" style={{ border: 0, margin: 0, padding: "12px 0" }}>
            <legend className="field__label" style={{ marginBottom: 8 }}>
              How often are you paid?
            </legend>
            {FREQUENCIES.map(([value, label]) => (
              <label className="chip-option" key={value}>
                <input
                  className="segmented__input"
                  type="radio"
                  name={`${ids}-frequency`}
                  value={value}
                  checked={frequency === value}
                  onChange={() => {
                    touched.current = true;
                    setFrequency(value);
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-payday`}>
              Next payday
            </label>
            <input
              id={`${ids}-payday`}
              className="field__input"
              type="date"
              value={nextPayday}
              onChange={(e) => {
                touched.current = true;
                setNextPayday(e.target.value);
              }}
            />
          </div>
        </div>
        <p className="auth__hint" role="status">
          {monthly !== null && amount.trim() ? (
            <>
              That's about <strong>{formatCents(monthly)} a month</strong>
              {nextPayday ? ` · next payday ${formatDay(nextPayday)}` : ""}
            </>
          ) : (
            "My income changes? Use an average paycheck."
          )}
        </p>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={continueFromPay}>
          Continue
        </Button>
        {onCancel ? (
          <Button block variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </>
    );
  }

  const m = monthly ?? 0;
  return (
    <>
      <h2 className="auth__title">Pick a budget style</h2>
      <p className="auth__lead">
        Based on <strong>{formatCents(m)} a month</strong>. You can switch anytime.
      </p>
      <fieldset
        style={{
          border: 0,
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <legend className="sr-only">Budget style</legend>
        <Card as="label" className="style-card">
          <input
            type="radio"
            name={`${ids}-method`}
            value="50_30_20"
            checked={method === "50_30_20"}
            onChange={() => setMethod("50_30_20")}
          />
          <div className="style-card__top">
            <span className="sk-card__title">Needs · wants · save</span>
            <Chip tone="accent">Suggested 50/30/20</Chip>
          </div>
          <p>Split your pay three ways. Start with ours, then make it yours.</p>
          <div className="style-card__bar" aria-hidden="true">
            <span style={{ width: `${(split?.need ?? 5000) / 100}%`, background: "var(--c-a1)" }} />
            <span style={{ width: `${(split?.want ?? 3000) / 100}%`, background: "var(--c-a3)" }} />
            <span style={{ width: `${(split?.save ?? 2000) / 100}%`, background: "var(--c-a2)" }} />
          </div>
          {method === "50_30_20" ? (
            <div className="split-edit">
              {(
                [
                  ["need", "Needs"],
                  ["want", "Wants"],
                  ["save", "Save"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="split-edit__field">
                  <span>{label}</span>
                  <span className="split-edit__box">
                    <input
                      className="auth__input"
                      inputMode="numeric"
                      maxLength={3}
                      aria-label={`${label}, percent of pay`}
                      value={pct[key]}
                      onChange={(e) =>
                        setPct({ ...pct, [key]: e.target.value.replace(/[^0-9]/g, "") })
                      }
                    />
                    %
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {method === "50_30_20" && total !== 100 ? (
            <p className="auth__error" role="status">
              Adds up to {total}%. Make it 100%.
            </p>
          ) : null}
          {method === "50_30_20" &&
          (pct.need !== "50" || pct.want !== "30" || pct.save !== "20") ? (
            <button
              type="button"
              className="auth__link"
              onClick={() => setPct({ need: "50", want: "30", save: "20" })}
            >
              Back to 50/30/20
            </button>
          ) : null}
          <div className="style-card__legend">
            <span>Needs {formatCents(targets?.need ?? 0)}</span>
            <span>Wants {formatCents(targets?.want ?? 0)}</span>
            <span>Save {formatCents(targets?.save ?? 0)}</span>
          </div>
        </Card>
        <Card as="label" className="style-card">
          <input
            type="radio"
            name={`${ids}-method`}
            value="zero_based"
            checked={method === "zero_based"}
            onChange={() => setMethod("zero_based")}
          />
          <div className="style-card__top">
            <span className="sk-card__title">Zero-based</span>
            <Chip tone="pending">Most control</Chip>
          </div>
          <p>Give every dollar a job until $0 is left to assign. More setup, sharper picture.</p>
          <div className="style-card__legend">
            <span>Left to assign</span>
            <span>{formatCents(m)} → $0</span>
          </div>
        </Card>
      </fieldset>
      {error && step === "method" ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={finish}>
        Continue
      </Button>
      {onCancel ? (
        <Button block variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      <p className="auth__fineprint">
        Not sure? 50/30/20 is a good start. Your split is yours to change anytime.
      </p>
    </>
  );
}
