import "../auth/auth.css";
import "../goals/goals.css";
import "../entries/entries.css";
import "./whatif.css";

import { Button, Card, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { AmountSlider } from "../../app/layout/AmountSlider.tsx";
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
import { ORDER_SETTING, orderLabel, usePlanDebts } from "../bills/debtPlan.ts";
import { EXTRA_SETTING } from "../bills/PayoffPlan.tsx";
import { newMoneyIn, useGoals } from "../goals/useGoals.ts";
import { WhatIfTimeline } from "./WhatIfTimeline.tsx";

/**
 * The four levers (a fixed choice: kinds, not values; October 28, 2026): a short label for the
 * segmented choice and the card's own title (October 29, 2026).
 */
export const LEVERS = [
  ["loan", "One loan", "Extra on a loan"],
  ["debts", "All debts", "Extra on all debts"],
  ["spend", "Spend less", "Spend less"],
  ["payday", "Payday", "Set aside each payday"],
] as const;
type Lever = (typeof LEVERS)[number][0];

/** Suggested amounts a month; every one also takes the person's own (signed off October 29, 2026). */
export const LOAN_EXTRAS = [5000, 10000, 20000];
export const SPEND_LESS = [2500, 5000, 10000];
/** The sliders' reach (layout only: an own amount past it widens the slider). */
const SLIDER_STEP = 500;
const LOAN_SLIDER_MAX = 60000;
const SPEND_SLIDER_MAX = 30000;

/** The person's last lever and amounts (October 29, 2026), so coming back feels like theirs. */
export const LAST_SETTING = "whatif.last";
export interface WhatIfLast {
  lever: Lever;
  loan: number;
  debts: number;
  spend: number;
  debt_id: string | null;
  category_id: string | null;
}

/** A saved `whatif.last` read safely: anything unknown is dropped. */
export function readLast(value: unknown): Partial<WhatIfLast> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const out: Partial<WhatIfLast> = {};
  if (LEVERS.some(([k]) => k === v.lever)) out.lever = v.lever as Lever;
  for (const k of ["loan", "debts", "spend"] as const) {
    const cents = typeof v[k] === "number" ? prefillAmount(String(v[k])) : null;
    if (cents !== null) out[k] = cents;
  }
  if (typeof v.debt_id === "string") out.debt_id = v.debt_id;
  if (typeof v.category_id === "string") out.category_id = v.category_id;
  return out;
}

function saveLast(db: ReturnType<typeof useDb>["db"], value: WhatIfLast): Promise<void> {
  return db.settings
    .put({ key: LAST_SETTING, value, updated_at: new Date().toISOString() })
    .then(() => undefined)
    .catch(ignoreClosed);
}

/** A small line icon per lever (decoration; the label says it). */
function LeverIcon({ lever }: { lever: Lever }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {lever === "loan" ? (
        <>
          <rect x="3" y="9" width="18" height="6" rx="3" {...common} />
          <path d="M7 12h6" {...common} />
        </>
      ) : lever === "debts" ? (
        <>
          <rect x="3" y="4" width="18" height="4" rx="2" {...common} />
          <rect x="3" y="10" width="14" height="4" rx="2" {...common} />
          <rect x="3" y="16" width="9" height="4" rx="2" {...common} />
        </>
      ) : lever === "spend" ? (
        <>
          <path d="M12 4v13" {...common} />
          <path d="M6 12l6 6 6-6" {...common} />
        </>
      ) : (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" {...common} />
          <path d="M3 10h18M8 3v4M16 3v4" {...common} />
        </>
      )}
    </svg>
  );
}

const DISCLAIMER = "An illustration from your own numbers, not advice.";

/** `?amount=` in whole cents, 1 to 999,999,999; null for anything else. */
export function prefillAmount(raw: string | null): number | null {
  if (raw === null || !/^[0-9]{1,9}$/.test(raw)) return null;
  const cents = Number.parseInt(raw, 10);
  return cents > 0 ? cents : null;
}

/** "4 months", "1 year", "1 year 4 months", "2 years 1 month". */
export function monthsWords(n: number): string {
  const months = (m: number) => `${m} ${m === 1 ? "month" : "months"}`;
  if (n < 12) return months(n);
  const years = Math.floor(n / 12);
  const rest = n % 12;
  const y = `${years} ${years === 1 ? "year" : "years"}`;
  return rest === 0 ? y : `${y} ${months(rest)}`;
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
  plus = true,
}: {
  legend: string;
  presets: number[];
  value: number;
  onChange: (cents: number) => void;
  /** "+$50" for an amount added on top; Spend less is an amount taken off, so no plus. */
  plus?: boolean;
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
            {plus ? "+" : ""}
            {formatCents(cents)}
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
function DebtResult({
  r,
  label,
  planExtra,
  add,
}: {
  r: WhatIfDebt;
  label: string | null;
  /** The amount the lever adds a month, for the second bar's label. */
  add: number;
  /** The extra already in the plan the lever adds to: 0 means the minimums alone. */
  planExtra: number;
}) {
  const word = r.status === "sooner" ? "Sooner" : r.status === "stalled" ? "Stalled" : "Same";
  const who = label ? `${label} paid off` : "Debt-free";
  let line: string;
  let detail: string | null = null;
  if (r.status === "stalled") {
    line = "At these amounts the balance keeps growing.";
  } else if (r.months_sooner === null) {
    line = `${who} by ${monthName(r.after.debt_free_month)}`;
    detail =
      planExtra > 0
        ? "Instead of never at your current plan."
        : "Instead of never at the minimums.";
  } else if (r.months_sooner > 0) {
    line = `${who} ${monthsWords(r.months_sooner)} sooner · ${formatCents(r.interest_saved_cents ?? 0)} less interest`;
    detail = `${monthName(r.after.debt_free_month)} instead of ${monthName(r.before.debt_free_month)}.`;
  } else {
    line = `${who} by ${monthName(r.after.debt_free_month)} either way`;
  }
  const interest = (c: number | null) => (c === null ? undefined : `${formatCents(c)} interest`);
  return (
    <Card as="section" aria-label={`What changes for ${label ?? "your debts"}`}>
      <Word>{word}</Word>
      <p role="status">{line}</p>
      {detail ? <p className="sk-card__eyebrow">{detail}</p> : null}
      <WhatIfTimeline
        what={who}
        before={{
          label: "Now",
          months: r.before.months,
          end: r.before.debt_free_month,
          note: interest(r.before.interest_cents),
        }}
        after={{
          label: `With ${formatCents(add)} more a month`,
          months: r.after.months,
          end: r.after.debt_free_month,
          note: interest(r.after.interest_cents),
        }}
      />
    </Card>
  );
}

/** The result of putting an amount into the top jar. */
function JarResult({ r, title, add }: { r: WhatIfGoal; title: string; add: number }) {
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
      <WhatIfTimeline
        what={`${title} jar done`}
        before={{ label: "At your pace now", months: r.months_now, end: r.finish_now }}
        after={{
          label: `With ${formatCents(add)} more a month`,
          months: r.months_new,
          end: r.finish_new,
        }}
      />
    </Card>
  );
}

/**
 * The jar the spend-less lever fills: the one asked for, else the top jar by priority. A jar
 * that grows over time is never one: its target is a future cost and it has its own monthly
 * plan (growth.goal_plan), which this flat months-to-fill reading would contradict.
 */
function useJarPace(goals: Goal[] | undefined, wanted: string | null, today: string) {
  const { db } = useDb();
  const jar =
    goals?.find((g) => g.id === wanted && g.kind === "save" && !g.grow) ??
    goals?.find(
      (g) =>
        g.kind === "save" &&
        !g.grow &&
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
  // The payoff plan's own debts, linked cards included (invariant 65).
  const debts = usePlanDebts()?.debts;
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

  // The last lever and amounts (October 29, 2026): applied once, under anything the address
  // asked for, then kept as the person moves them.
  const last = useLiveQuery(
    async () => readLast((await db.settings.get(LAST_SETTING))?.value),
    [db],
  );
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (applied || last === undefined) return;
    const fromLink = asked !== null && LEVERS.some(([k]) => k === asked);
    if (!fromLink && !params.get("goal") && last.lever) setLever(last.lever);
    const linked = prefill !== null ? (fromLink ? asked : null) : null;
    if (last.loan && linked !== "loan") setLoanAdd(last.loan);
    if (last.debts && linked !== "debts") setAllAdd(last.debts);
    if (last.spend && linked !== "spend") setSpendAdd(last.spend);
    if (last.debt_id && !params.get("debt")) setDebtId(last.debt_id);
    if (last.category_id && !params.get("category")) setCategoryId(last.category_id);
    setApplied(true);
  }, [applied, last, asked, prefill, params]);
  useEffect(() => {
    if (!applied) return;
    const value: WhatIfLast = {
      lever,
      loan: loanAdd,
      debts: allAdd,
      spend: spendAdd,
      debt_id: debtId,
      category_id: categoryId || null,
    };
    // Written at once (one small row on this device): a delay would lose the last try when the
    // page is left or reloaded before it ran, and no unmount runs on a page unload.
    void saveLast(db, value);
  }, [applied, db, lever, loanAdd, allAdd, spendAdd, debtId, categoryId]);

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
      // across the months (an approximation; signed off by the owner, October 29, 2026).
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
      <fieldset className="segmented whatif-levers">
        <legend className="sr-only">What to change</legend>
        {LEVERS.map(([k, short]) => (
          <label className="segmented__option" key={k}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-lever`}
              value={k}
              checked={lever === k}
              onChange={() => setLever(k)}
            />
            <LeverIcon lever={k} />
            {short}
          </label>
        ))}
      </fieldset>

      {lever === "loan" && loanResult && debt && !noDebts ? (
        <DebtResult r={loanResult} label={debt.label} planExtra={0} add={loanAdd} />
      ) : null}
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
              <AmountSlider
                label="Put in"
                suffix="more a month"
                value={loanAdd}
                min={SLIDER_STEP}
                step={SLIDER_STEP}
                max={LOAN_SLIDER_MAX}
                onChange={setLoanAdd}
              />
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

      {lever === "debts" && allResult && !noDebts ? (
        <DebtResult r={allResult} label={null} planExtra={extra ?? 0} add={allAdd} />
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
              <AmountSlider
                label="Put in"
                suffix="more a month"
                value={allAdd}
                min={SLIDER_STEP}
                step={SLIDER_STEP}
                max={LOAN_SLIDER_MAX}
                onChange={setAllAdd}
              />
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

      {lever === "spend" && spendJar && jar ? (
        <JarResult r={spendJar} title={jar.title} add={spendAdd} />
      ) : null}
      {lever === "spend" && !jar && goals !== undefined ? (
        <Card as="section" aria-label="No jar yet">
          <Word>Start</Word>
          <p>
            <Link to="/goals/new">Make a jar</Link> to see when it would be done.
          </p>
          {goals.some((g) => g.grow && g.status === "active") ? (
            <p className="sk-card__eyebrow">
              A jar that grows over time keeps its own monthly plan on its screen.
            </p>
          ) : null}
        </Card>
      ) : null}
      {lever === "spend" && spendDebts ? (
        <DebtResult r={spendDebts} label={null} planExtra={extra ?? 0} add={spendAdd} />
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
          <AmountSlider
            label="Spend"
            suffix="less a month"
            value={spendAdd}
            min={SLIDER_STEP}
            step={SLIDER_STEP}
            max={SPEND_SLIDER_MAX}
            onChange={setSpendAdd}
          />
          <AmountChoice
            legend={`Less on ${category?.name ?? "it"} each month`}
            presets={SPEND_LESS}
            value={spendAdd}
            onChange={setSpendAdd}
            plus={false}
          />
          <p className="sk-card__eyebrow">
            Then put the {formatCents(spendAdd)} a month toward a jar or your debts.
          </p>
        </Card>
      ) : null}

      {lever === "payday" ? (
        <Card as="section" aria-label="Set aside each payday">
          <Word>Next</Word>
          <p>See your balance with an amount set aside each payday.</p>
          <p>
            <Link to="/forecast">Open Next 30 days → Try</Link>
          </p>
        </Card>
      ) : null}

      <p className="auth__fineprint">
        {DISCLAIMER} Nothing is moved; your last try is kept on this device for next time.
      </p>
    </>
  );
}
