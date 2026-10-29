import "../auth/auth.css";
import "../goals/goals.css";

import { Button, Card, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Debt, type Goal, ignoreClosed } from "../../data/db.ts";
import {
  addMonths,
  type DebtInput,
  goalProgress,
  parseAmount,
  roundDiv,
  type WhatIfDebt,
  type WhatIfGoal,
  whatIfDebt,
  whatIfGoal,
} from "../../engine/bridge.ts";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { ORDER_SETTING, orderLabel } from "../bills/debtPlan.ts";
import { EXTRA_SETTING } from "../bills/PayoffPlan.tsx";
import { newMoneyIn, useGoals } from "../goals/useGoals.ts";

/** The four levers (a fixed choice: kinds, not values; October 28, 2026). */
export const LEVERS = [
  ["loan", "Extra on a loan"],
  ["debts", "Extra on all debts"],
  ["spend", "Spend less"],
  ["payday", "Set aside each payday"],
] as const;
type Lever = (typeof LEVERS)[number][0];

/** Suggested amounts a month; every one also takes the person's own (proposed). */
export const LOAN_EXTRAS = [5000, 10000, 20000];
export const SPEND_LESS = [2500, 5000, 10000];

const DISCLAIMER = "An illustration from your own numbers, not advice.";

/** `?amount=` in whole cents, 1 to 999,999,999; null for anything else. */
export function prefillAmount(raw: string | null): number | null {
  if (raw === null || !/^[0-9]{1,9}$/.test(raw)) return null;
  const cents = Number.parseInt(raw, 10);
  return cents > 0 ? cents : null;
}

function monthsWords(n: number): string {
  if (n >= 24 && n % 12 === 0) return `${n / 12} years`;
  return `${n} ${n === 1 ? "month" : "months"}`;
}

function monthName(ym: string | null): string {
  return ym ? formatMonth(`${ym}-01`) : "now";
}

function toInput(d: Debt): DebtInput {
  return {
    id: d.id,
    label: d.label,
    balance_cents: d.balance_cents,
    apr_bps: d.apr_bps,
    min_payment_cents: d.min_payment_cents,
  };
}

/** Suggested amounts as chips plus the person's own, read by the engine's parseAmount. */
function AmountChoice({
  legend,
  presets,
  value,
  onChange,
}: {
  legend: string;
  presets: number[];
  value: number;
  onChange: (cents: number) => void;
}) {
  const ids = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function use() {
    try {
      const cents = await parseAmount(text);
      if (cents <= 0) throw new Error("not positive");
      setError(null);
      onChange(cents);
    } catch {
      setError("Enter an amount like 75.");
    }
  }
  return (
    <>
      <fieldset className="kind-chips" style={{ border: 0, margin: "8px 0 0", padding: 0 }}>
        <legend className="auth__label">{legend}</legend>
        {presets.map((cents) => (
          <label className="chip-option" key={cents}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-amount`}
              value={cents}
              checked={value === cents}
              onChange={() => onChange(cents)}
            />
            +{formatCents(cents)}
          </label>
        ))}
      </fieldset>
      <div className="transfer-choice" style={{ gridTemplateColumns: "1fr auto", marginTop: 8 }}>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder={presets.includes(value) ? "Your own amount" : formatCents(value)}
          aria-label={`Your own amount: ${legend}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="secondary" onClick={use}>
          Use
        </Button>
      </div>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** The result of a debt lever: one word, then what it means. */
function DebtResult({ r, label }: { r: WhatIfDebt; label: string | null }) {
  const word = r.status === "sooner" ? "Sooner" : r.status === "stalled" ? "Stalled" : "Same";
  const who = label ? `${label} paid off` : "Debt-free";
  let line: string;
  let detail: string | null = null;
  if (r.status === "stalled") {
    line = "At these amounts the balance keeps growing.";
  } else if (r.months_sooner === null) {
    line = `${who} by ${monthName(r.after.debt_free_month)}`;
    detail = "Instead of never at the minimums.";
  } else if (r.months_sooner > 0) {
    line = `${who} ${monthsWords(r.months_sooner)} sooner · ${formatCents(r.interest_saved_cents ?? 0)} less interest`;
    detail = `${monthName(r.after.debt_free_month)} instead of ${monthName(r.before.debt_free_month)}.`;
  } else {
    line = `${who} by ${monthName(r.after.debt_free_month)} either way`;
  }
  return (
    <Card as="section" aria-label={`What changes for ${label ?? "your debts"}`}>
      <Word>{word}</Word>
      <p role="status">{line}</p>
      {detail ? <p className="sk-card__eyebrow">{detail}</p> : null}
    </Card>
  );
}

/** The result of putting an amount into the top jar. */
function JarResult({ r, title }: { r: WhatIfGoal; title: string }) {
  const word = r.status === "sooner" ? "Sooner" : r.status === "never" ? "Stalled" : "Same";
  let line: string;
  let detail: string | null = null;
  if (r.status === "never") {
    line = `${title} jar: no date at this pace`;
  } else if (r.months_sooner === null) {
    line = `${title} jar done by ${monthName(r.finish_new)}`;
    detail = "Instead of no date at your pace over the last 3 months.";
  } else if (r.months_sooner > 0) {
    line = `${title} jar done ${monthsWords(r.months_sooner)} earlier`;
    detail = `${monthName(r.finish_new)} instead of ${monthName(r.finish_now)}.`;
  } else {
    line = `${title} jar done by ${monthName(r.finish_new)} either way`;
  }
  return (
    <Card as="section" aria-label={`What changes for ${title}`}>
      <Word>{word}</Word>
      <p role="status">{line}</p>
      {detail ? <p className="sk-card__eyebrow">{detail}</p> : null}
    </Card>
  );
}

/** The jar the spend-less lever fills: the one asked for, else the top jar by priority. */
function useJarPace(goals: Goal[] | undefined, wanted: string | null, today: string) {
  const { db } = useDb();
  const jar =
    goals?.find((g) => g.id === wanted && g.kind === "save") ??
    goals?.find(
      (g) =>
        g.kind === "save" &&
        g.status === "active" &&
        !g.is_ongoing &&
        !g.paused_at &&
        (g.target_cents ?? 0) > 0,
    ) ??
    null;
  const events = useLiveQuery(() => db.goal_events.toArray(), [db]);
  const [pace, setPace] = useState<{ remaining: number; perMonth: number } | null>(null);
  useEffect(() => {
    if (!jar || !events) return;
    let alive = true;
    void (async () => {
      const own = events.filter((e) => e.goal_id === jar.id);
      const p = await goalProgress(
        {
          kind: "save",
          target_cents: jar.target_cents ?? 0,
          start_date: jar.start_date,
          end_date: jar.end_date,
        },
        own
          .slice()
          .sort((a, b) => compareText(a.date, b.date) || compareText(a.created_at, b.created_at))
          .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents })),
        today,
      );
      // Your own pace: new money into this jar over the last 3 months, a month's share of it.
      const since = await addMonths(today, -3);
      const recent = newMoneyIn(events).filter(
        (e) =>
          e.goal_id === jar.id && compareText(e.date, since) > 0 && compareText(e.date, today) <= 0,
      );
      const total = recent.reduce((sum, e) => sum + (e.amount_cents ?? 0), 0);
      const perMonth = await roundDiv(total, 3);
      if (alive) setPace({ remaining: p.remaining, perMonth });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [jar, events, today]);
  return { jar, pace };
}

/**
 * What if (October 28, 2026; docs/spec.md "What if"): one lever moved, the same plan run twice
 * through `whatif.debt` (the payoff plan) or `whatif.goal` (months to fill a jar). The fourth
 * lever is the forecast's own Try card. An illustration, never advice; nothing is saved or moved.
 */
export function WhatIfScreen() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const [params] = useSearchParams();
  const debts = useLiveQuery(() => db.debts.toArray(), [db]);
  const extra = useLiveQuery(
    async () => ((await db.settings.get(EXTRA_SETTING))?.value as number | undefined) ?? 0,
    [db],
  );
  // The person's own order on Debt payoff (October 28, 2026): every debt lever follows it.
  const order = useLiveQuery(
    async () =>
      (await db.settings.get(ORDER_SETTING))?.value === "snowball"
        ? ("snowball" as const)
        : ("avalanche" as const),
    [db],
  );
  const categories = useLiveQuery(
    async () =>
      (await db.categories.where("kind").equals("expense").sortBy("sort")).filter((c) => !c.hidden),
    [db],
  );
  const goals = useGoals();
  const { jar, pace } = useJarPace(goals, params.get("goal"), today);

  const asked = params.get("lever");
  const [lever, setLever] = useState<Lever>(
    LEVERS.some(([k]) => k === asked) ? (asked as Lever) : params.get("goal") ? "spend" : "loan",
  );
  // Prefilled from the address (the month review's "Try it in What if"; October 28, 2026): an
  // amount for the lever asked, a category the person has. Anything else is ignored.
  const prefill = prefillAmount(params.get("amount"));
  const [debtId, setDebtId] = useState<string | null>(params.get("debt"));
  const [loanAdd, setLoanAdd] = useState(lever === "loan" ? (prefill ?? 10000) : 10000);
  const [halfBiweekly, setHalfBiweekly] = useState(false);
  const [allAdd, setAllAdd] = useState(lever === "debts" ? (prefill ?? 10000) : 10000);
  const [categoryId, setCategoryId] = useState<string>(params.get("category") ?? "");
  const [spendAdd, setSpendAdd] = useState(lever === "spend" ? (prefill ?? 5000) : 5000);
  const [loanResult, setLoanResult] = useState<WhatIfDebt | null>(null);
  const [allResult, setAllResult] = useState<WhatIfDebt | null>(null);
  const [spendDebts, setSpendDebts] = useState<WhatIfDebt | null>(null);
  const [spendJar, setSpendJar] = useState<WhatIfGoal | null>(null);

  const debt = debts?.find((d) => d.id === debtId) ?? debts?.[0] ?? null;
  const category =
    categories?.find((c) => c.id === categoryId) ??
    categories?.find((c) => c.id === "cat-dining") ??
    categories?.[0] ??
    null;

  useEffect(() => {
    if (lever !== "loan" || !debt) return;
    let alive = true;
    void (async () => {
      // Half every two weeks: 26 half payments are one extra full payment a year, spread
      // across the months (an approximation; proposed, awaiting owner sign-off).
      const yearly = halfBiweekly ? await roundDiv(debt.min_payment_cents, 12) : 0;
      const r = await whatIfDebt([toInput(debt)], 0, loanAdd + yearly, today, order ?? null);
      if (alive) setLoanResult(r);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [lever, debt, loanAdd, halfBiweekly, today, order]);

  useEffect(() => {
    if (lever !== "debts" || !debts?.length || extra === undefined || !order) return;
    let alive = true;
    void whatIfDebt(debts.map(toInput), extra, allAdd, today, order)
      .then((r) => {
        if (alive) setAllResult(r);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [lever, debts, extra, allAdd, today, order]);

  useEffect(() => {
    if (lever !== "spend") return;
    let alive = true;
    void (async () => {
      const [onJar, onDebts] = await Promise.all([
        jar && pace ? whatIfGoal(pace.remaining, pace.perMonth, spendAdd, today) : null,
        debts?.length && extra !== undefined && order
          ? whatIfDebt(debts.map(toInput), extra, spendAdd, today, order)
          : null,
      ]);
      if (!alive) return;
      setSpendJar(onJar);
      setSpendDebts(onDebts);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [lever, jar, pace, debts, extra, spendAdd, today, order]);

  const noDebts = debts !== undefined && debts.length === 0;
  const addDebt = (
    <p>
      Add a card or loan on <Link to="/bills">Bills → Debt payoff</Link> first.
    </p>
  );

  return (
    <>
      <ScreenHeader title="What if" actions={null} back="/insights" />
      <fieldset className="kind-chips" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="sr-only">What to change</legend>
        {LEVERS.map(([k, label]) => (
          <label className="chip-option" key={k}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-lever`}
              value={k}
              checked={lever === k}
              onChange={() => setLever(k)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {lever === "loan" ? (
        <Card as="section" aria-label="Extra on a loan">
          <h2 className="sk-card__title">Put more on one loan</h2>
          {noDebts ? (
            addDebt
          ) : (
            <>
              <fieldset className="kind-chips" style={{ border: 0, margin: 0, padding: 0 }}>
                <legend className="auth__label">Which one</legend>
                {(debts ?? []).map((d) => (
                  <label className="chip-option" key={d.id}>
                    <input
                      className="segmented__input"
                      type="radio"
                      name={`${ids}-debt`}
                      value={d.id}
                      checked={debt?.id === d.id}
                      onChange={() => setDebtId(d.id)}
                    />
                    {d.label}
                  </label>
                ))}
              </fieldset>
              <AmountChoice
                legend="Extra each month"
                presets={LOAN_EXTRAS}
                value={loanAdd}
                onChange={setLoanAdd}
              />
              <Toggle
                checked={halfBiweekly}
                onChange={setHalfBiweekly}
                label="Pay half every two weeks"
                description="Counted as one extra payment a year, spread across the months. An approximation."
              />
            </>
          )}
        </Card>
      ) : null}
      {lever === "loan" && loanResult && debt && !noDebts ? (
        <DebtResult r={loanResult} label={debt.label} />
      ) : null}

      {lever === "debts" ? (
        <Card as="section" aria-label="Extra on all debts">
          <h2 className="sk-card__title">Put more on your debts</h2>
          {noDebts ? (
            addDebt
          ) : (
            <>
              <p className="sk-card__eyebrow">
                On top of your payoff plan
                {extra ? `'s ${formatCents(extra)} extra` : ""},{" "}
                {orderLabel(order ?? "avalanche").toLowerCase()}.
              </p>
              <AmountChoice
                legend="More each month"
                presets={LOAN_EXTRAS}
                value={allAdd}
                onChange={setAllAdd}
              />
            </>
          )}
        </Card>
      ) : null}
      {lever === "debts" && allResult && !noDebts ? (
        <DebtResult r={allResult} label={null} />
      ) : null}

      {lever === "spend" ? (
        <Card as="section" aria-label="Spend less">
          <h2 className="sk-card__title">Spend less on one thing</h2>
          <label className="auth__field">
            <span className="auth__label">Category</span>
            <select
              className="auth__input"
              value={category?.id ?? ""}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {(categories ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <AmountChoice
            legend={`Less on ${category?.name ?? "it"} each month`}
            presets={SPEND_LESS}
            value={spendAdd}
            onChange={setSpendAdd}
          />
          <p className="sk-card__eyebrow">
            Then put the {formatCents(spendAdd)} a month toward a jar or your debts.
          </p>
        </Card>
      ) : null}
      {lever === "spend" && spendJar && jar ? <JarResult r={spendJar} title={jar.title} /> : null}
      {lever === "spend" && !jar && goals !== undefined ? (
        <Card as="section" aria-label="No jar yet">
          <Word>Start</Word>
          <p>
            <Link to="/goals/new">Make a jar</Link> to see when it would be done.
          </p>
        </Card>
      ) : null}
      {lever === "spend" && spendDebts ? <DebtResult r={spendDebts} label={null} /> : null}

      {lever === "payday" ? (
        <Card as="section" aria-label="Set aside each payday">
          <Word>Next</Word>
          <p>See your balance with an amount set aside each payday.</p>
          <p>
            <Link to="/forecast">Open Next 30 days → Try</Link>
          </p>
        </Card>
      ) : null}

      <p className="auth__fineprint">{DISCLAIMER} Nothing is saved or moved.</p>
    </>
  );
}
