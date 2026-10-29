import "./forecast.css";
import { BillsCalendar } from "./BillsCalendar.tsx";
import "../auth/auth.css";

import { Button, buttonClass, Card, Chip, Illustration, Sheet } from "@stackd/ui";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Arranged } from "../../app/layout/Arranged.tsx";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Projection, parseAmount, type UpcomingItem } from "../../engine/bridge.ts";
import { formatCents, formatDay, formatMonth, todayIso } from "../../lib/format.ts";
import { accountLabel } from "../entries/useEntries.ts";
import { BiggerMonths } from "../insights/BiggerMonths.tsx";
import { SafeToSpendLine } from "../insights/SafeToSpendLine.tsx";
import { useSafeToSpend } from "../insights/useSafeToSpend.ts";
import { balanceSourceText } from "../linking/anchorText.ts";
import { ForecastChart } from "./ForecastChart.tsx";
import { type ForecastView, setBalance, setBuffer, useForecast } from "./useForecast.ts";
import { INTERVAL_LABELS, useRecurringSuggestions } from "./useRecurring.ts";
import { WhatIf, type WhatIfInput } from "./WhatIf.tsx";

/** The screen's cards in their default order; each person arranges their own (October 25, 2026). */
export const FORECAST_CARDS = [
  ["status", "Covered or short", "One word on the days ahead"],
  ["balance", "Estimated balance", "The line with pay and bills"],
  ["try", "Try", "What if you spent less or saved more"],
  ["upcoming", "Upcoming", "Bills and pay, as a list or calendar"],
  ["bigger", "Bigger months ahead", "Quarterly and yearly bills"],
] as const;
type ForecastCardId = (typeof FORECAST_CARDS)[number][0];

/** How far ahead (October 25, 2026): a month, a quarter or a year, remembered on this device. */
export const SPANS = [
  { key: "month", label: "Month", days: 30, title: "Next 30 days", name: "30 days" },
  { key: "quarter", label: "Quarter", days: 91, title: "Next quarter", name: "the next quarter" },
  { key: "year", label: "Year", days: 365, title: "Next year", name: "the next year" },
] as const;
type SpanKey = (typeof SPANS)[number]["key"];
const SPAN_KEY = "stackd.forecast.span";

function savedSpan(): SpanKey {
  try {
    const v = localStorage.getItem(SPAN_KEY);
    return SPANS.some((s) => s.key === v) ? (v as SpanKey) : "month";
  } catch {
    return "month";
  }
}

/** The one-word verdict and its line (owner, October 25, 2026: one word of value, then why). */
export function forecastStatus(
  p: Projection,
  cushionCents: number,
): { word: "Covered" | "Short"; line: string } {
  if (p.shortfall) return { word: "Short", line: shortfallLine(p) };
  const lowest = `Lowest ${formatCents(p.lowest_cents)} on ${formatDay(p.lowest_date)}`;
  if (cushionCents <= 0) return { word: "Covered", line: `${lowest}. Never below zero.` };
  const room = p.lowest_cents - cushionCents;
  return { word: "Covered", line: `${lowest}, ${formatCents(room)} above your cushion.` };
}

/**
 * The shortfall in one line, each number with its own date (owner, October 19, 2026: the deepest
 * amount was paired with the first day under the cushion): when it first dips below the cushion,
 * and how short it gets by the lowest day. One date when they are the same day.
 */
export function shortfallLine(p: {
  short_by_cents: number;
  first_short_date: string | null;
  lowest_date: string;
}): string {
  const amount = formatCents(p.short_by_cents);
  const first = p.first_short_date ?? todayIso();
  if (first === p.lowest_date) return `You may be short ${amount} on ${formatDay(first)}`;
  return `Below your cushion from ${formatDay(first)}, short up to ${amount} by ${formatDay(p.lowest_date)}`;
}

/** Upcoming items grouped by calendar month ("2026-11"), in date order. */
function byMonth(items: UpcomingItem[]): Array<[string, UpcomingItem[]]> {
  const out = new Map<string, UpcomingItem[]>();
  for (const i of items) out.set(i.date.slice(0, 7), [...(out.get(i.date.slice(0, 7)) ?? []), i]);
  return [...out.entries()];
}

function kindLine(item: UpcomingItem, view: ForecastView): string {
  const s = view.series.get(item.series_id);
  const interval = s
    ? (INTERVAL_LABELS[s.interval as keyof typeof INTERVAL_LABELS] ?? s.interval)
    : "";
  const what = item.kind === "income" ? "Income" : "Bill";
  if (s?.source === "pay") return `${what} · ${interval.toLowerCase()} · from your pay settings`;
  return `${what} · ${interval.toLowerCase()}`;
}

/** Next 30 days (mockup F3Forecast): shortfall, estimated balance, how we calculated it, the list. */
export function ForecastScreen() {
  const { db } = useDb();
  const today = todayIso();
  const [spanKey, setSpanKey] = useState<SpanKey>(savedSpan);
  const span = SPANS.find((s) => s.key === spanKey) ?? SPANS[0];
  const chooseSpan = (k: SpanKey) => {
    setSpanKey(k);
    try {
      localStorage.setItem(SPAN_KEY, k);
    } catch {
      /* private mode: still switches for this visit */
    }
  };
  const view = useForecast(today, span.days);
  const [whatIfLine, setWhatIfLine] = useState<Projection["days"] | null>(null);
  const onWhatIf = useCallback((d: Projection["days"] | null) => setWhatIfLine(d), []);
  const safe = useSafeToSpend(view, today);
  const suggestions = useRecurringSuggestions(today);
  const [open, setOpen] = useState<"balance" | "buffer" | null>(null);
  // List or calendar, remembered on this device (October 20, 2026).
  const [upView, setUpView] = useState<"list" | "calendar">(() => {
    try {
      return localStorage.getItem("stackd.upcoming.view") === "calendar" ? "calendar" : "list";
    } catch {
      return "list";
    }
  });
  const chooseUpView = (v: "list" | "calendar") => {
    setUpView(v);
    try {
      localStorage.setItem("stackd.upcoming.view", v);
    } catch {
      /* private mode: still switches for this visit */
    }
  };
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const p = view.projection;
  const whatIfInput = useMemo<WhatIfInput | null>(
    () =>
      p && view.start?.balance_cents != null && view.daily && view.upcoming
        ? {
            asOf: today,
            days: span.days,
            startCents: view.start.balance_cents,
            dailyCents: view.daily.cents_per_day,
            items: view.upcoming.items,
            bufferCents: view.bufferCents,
            base: p,
          }
        : null,
    [p, view.start, view.daily, view.upcoming, view.bufferCents, today, span.days],
  );
  const status = p ? forecastStatus(p, view.bufferCents) : null;
  const upRow = (item: UpcomingItem) => (
    <div className="up-row" key={`${item.series_id}:${item.date}`}>
      <span className="up-row__date">{formatDay(item.date)}</span>
      <span>
        <span className="up-row__label">
          {view.series.get(item.series_id)?.label ?? item.payee}
        </span>
        <br />
        <span className="up-row__kind">{kindLine(item, view)}</span>
        {item.matched ? <Chip tone="success">Paid</Chip> : null}
      </span>
      <span className={`up-row__amount${item.kind === "income" ? " up-row__amount--in" : ""}`}>
        {formatCents(item.amount_cents, item.kind === "income" ? "in" : "out")}
      </span>
    </div>
  );

  async function amountFromText(): Promise<number | null> {
    try {
      return await parseAmount(text);
    } catch {
      setError("Enter an amount like 2,100.");
      return null;
    }
  }

  async function saveBalance() {
    const cents = await amountFromText();
    if (cents === null || !view.account) return;
    await setBalance(db, view.account.id, cents, today);
    setText("");
    setOpen(null);
  }

  async function saveBuffer() {
    const cents = await amountFromText();
    if (cents === null) return;
    if (cents < 0) {
      setError("A cushion can't be negative.");
      return;
    }
    await setBuffer(db, cents);
    setText("");
    setOpen(null);
  }

  const incomeTotal = (view.upcoming?.items ?? [])
    .filter((i) => i.kind === "income" && !i.matched)
    .reduce((s, i) => s + i.amount_cents, 0);
  const billsTotal = (view.upcoming?.items ?? [])
    .filter((i) => i.kind === "bill" && !i.matched)
    .reduce((s, i) => s + i.amount_cents, 0);

  const card = (id: ForecastCardId) => {
    switch (id) {
      case "status":
        return (
          <>
            {p && status ? (
              <Card
                as="section"
                className={p.shortfall ? "forecast__warn" : "forecast__status--ok"}
                aria-label={p.shortfall ? "Shortfall" : "Covered"}
              >
                <h2 className="forecast__status-word">{status.word}</h2>
                <p>{status.line}</p>
                <p className="auth__hint">
                  {p.shortfall
                    ? "An estimate from your own history. Moving money from a jar or delaying a purchase would cover it."
                    : "An estimate from your own history, not a guarantee."}
                </p>
              </Card>
            ) : null}
          </>
        );
      case "balance":
        return (
          <>
            {p ? (
              <Card as="section" aria-label="Estimated balance">
                <div className="hero-split">
                  <span className="sk-card__eyebrow">
                    {view.account ? accountLabel(view.account) : "Balance"} balance, estimated
                  </span>
                  <button type="button" className="auth__link" onClick={() => setOpen("buffer")}>
                    Cushion {formatCents(view.bufferCents)}
                  </button>
                </div>
                <ForecastChart
                  days={p.days}
                  bufferCents={view.bufferCents}
                  lowestDate={p.lowest_date}
                  lowestCents={p.lowest_cents}
                  items={view.upcoming?.items ?? []}
                  // Only a line for these same days: never one drawn for another span.
                  whatIf={whatIfLine?.length === p.days.length ? whatIfLine : null}
                />
                <SafeToSpendLine value={safe} />
                <p className={`forecast__lowest${p.shortfall ? " forecast__lowest--bad" : ""}`}>
                  Lowest {formatCents(p.lowest_cents)} · {formatDay(p.lowest_date)}
                </p>
                <details className="forecast__how">
                  <summary>How we calculated this</summary>
                  <dl>
                    <dt>
                      Starting balance
                      {view.anchor
                        ? ` (${balanceSourceText(view.anchor, view.account)}, plus ${view.start?.entries_since ?? 0} entries since)`
                        : ""}
                    </dt>
                    <dd>{formatCents(view.start?.balance_cents ?? 0)}</dd>
                    <dt>Expected income in {span.name}</dt>
                    <dd>{formatCents(incomeTotal)}</dd>
                    <dt>Expected bills in {span.name}</dt>
                    <dd>{formatCents(billsTotal)}</dd>
                    <dt>
                      Typical daily spending (
                      {view.daily?.basis === "history"
                        ? `last ${Math.min(view.daily.days_of_history, 90)} days, non-recurring`
                        : view.daily?.basis === "budget"
                          ? "your budget, until 30 days of history"
                          : "none yet"}
                      )
                    </dt>
                    <dd>{formatCents(view.daily?.cents_per_day ?? 0)} a day</dd>
                    <dt>Cushion</dt>
                    <dd>{formatCents(view.bufferCents)}</dd>
                  </dl>
                  <p className="auth__hint">
                    Each day: start + pay − bills − your daily spending. It assumes the next days
                    look like your recent ones.
                  </p>
                </details>
                {view.account ? (
                  <Button variant="ghost" size="sm" onClick={() => setOpen("balance")}>
                    Update balance
                  </Button>
                ) : null}
              </Card>
            ) : null}
          </>
        );
      case "try":
        return <>{whatIfInput ? <WhatIf input={whatIfInput} onLine={onWhatIf} /> : null}</>;
      case "upcoming":
        return (
          <Card as="section" aria-label="Upcoming">
            <div className="up-head">
              <h2 className="sk-card__title">Upcoming</h2>
              {view.upcoming && view.upcoming.items.length > 0 ? (
                <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
                  <legend className="sr-only">Show as</legend>
                  {(
                    [
                      ["list", "List"],
                      ["calendar", "Calendar"],
                    ] as const
                  ).map(([value, label]) => (
                    <label className="segmented__option" key={value}>
                      <input
                        className="segmented__input"
                        type="radio"
                        name="upcoming-view"
                        checked={upView === value}
                        onChange={() => chooseUpView(value)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </div>
            {view.upcoming && view.upcoming.items.length > 0 && upView === "calendar" ? (
              <BillsCalendar
                start={view.upcoming.start}
                end={view.upcoming.end}
                today={today}
                items={view.upcoming.items}
                balances={
                  new Map((view.projection?.days ?? []).map((d) => [d.date, d.balance_cents]))
                }
                cushionCents={view.bufferCents}
                labelFor={(item) => view.series.get(item.series_id)?.label ?? item.payee}
              />
            ) : null}
            {view.upcoming && view.upcoming.items.length === 0 ? (
              <>
                <Illustration name="calendar" tone="a2" />
                <p>
                  Nothing expected yet. Confirm bills and income under{" "}
                  <Link to="/bills">Bills</Link>, or set your pay in Budget, and they show up here.
                </p>
              </>
            ) : null}
            {upView === "list" && span.key === "month"
              ? (view.upcoming?.items ?? []).map((item) => upRow(item))
              : null}
            {upView === "list" && span.key !== "month"
              ? byMonth(view.upcoming?.items ?? []).map(([month, items]) => {
                  const inC = items
                    .filter((i) => i.kind === "income")
                    .reduce((t, i) => t + i.amount_cents, 0);
                  const outC = items
                    .filter((i) => i.kind === "bill")
                    .reduce((t, i) => t + i.amount_cents, 0);
                  return (
                    <details className="up-month" key={month}>
                      <summary>
                        <span className="up-month__name">{formatMonth(month)}</span>
                        <span className="up-row__amount up-row__amount--in">
                          {formatCents(inC, "in")}
                        </span>
                        <span className="up-row__amount">
                          {outC ? formatCents(outC, "out") : ""}
                        </span>
                      </summary>
                      {items.map((item) => upRow(item))}
                    </details>
                  );
                })
              : null}
          </Card>
        );
      case "bigger":
        return (
          <BiggerMonths
            asOf={today}
            labels={
              new Map(
                [...view.series.values()].map((v) => [
                  v.label.replace(/\s+/g, " ").trim().toUpperCase(),
                  v.label,
                ]),
              )
            }
          />
        );
    }
  };

  return (
    <>
      <ScreenHeader
        title={span.title}
        back="/"
        actions={
          <Link to="/bills" className={buttonClass({ size: "sm", variant: "secondary" })}>
            Bills
          </Link>
        }
      />
      <fieldset className="segmented forecast__spans" style={{ border: 0 }}>
        <legend className="sr-only">How far ahead</legend>
        {SPANS.map((s) => (
          <label className="segmented__option" key={s.key}>
            <input
              className="segmented__input"
              type="radio"
              name="forecast-span"
              checked={spanKey === s.key}
              onChange={() => chooseSpan(s.key)}
            />
            {s.label}
          </label>
        ))}
      </fieldset>
      {view.loading ? (
        <p className="sr-only" role="status">
          Loading
        </p>
      ) : null}
      {!view.loading && view.needsBalance ? (
        <Card as="section" aria-label="Balance needed">
          <h2 className="sk-card__title">
            What's in your {view.account ? accountLabel(view.account) : "account"} right now?
          </h2>
          <p>
            The forecast starts from a balance: a statement's ending balance, or one you type in.
            Until then, here is what's coming up.
          </p>
          <Button block onClick={() => setOpen("balance")} disabled={!view.account}>
            Enter a balance
          </Button>
        </Card>
      ) : null}
      <Arranged screen="forecast" name="Next 30 days" cards={FORECAST_CARDS} render={card} />
      {suggestions && suggestions.length > 0 ? (
        <Card>
          <p>
            {suggestions.length} {suggestions.length === 1 ? "payee looks" : "payees look"}{" "}
            recurring in your statements. <Link to="/bills">Review them</Link> so they count here.
          </p>
        </Card>
      ) : null}
      <p className="auth__fineprint">
        An estimate based on your own history. Not a guarantee, not advice.
      </p>

      <Sheet
        open={open === "balance"}
        onClose={() => setOpen(null)}
        title={`Balance in ${view.account ? accountLabel(view.account) : "your account"}`}
      >
        <p className="auth__hint">Today's balance. Entries you add after today adjust it.</p>
        <label className="auth__field">
          <span className="auth__label">Balance</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="2,100.00"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={saveBalance}>
          Save balance
        </Button>
      </Sheet>
      <Sheet open={open === "buffer"} onClose={() => setOpen(null)} title="Your cushion">
        <p className="auth__hint">
          The least you want to keep in the account. The forecast warns when it dips below this.
        </p>
        <label className="auth__field">
          <span className="auth__label">Cushion</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="0"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={saveBuffer}>
          Save cushion
        </Button>
      </Sheet>
    </>
  );
}
