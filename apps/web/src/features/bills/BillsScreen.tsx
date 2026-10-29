import { Word } from "../../app/layout/Word.tsx";
import "../forecast/forecast.css";
import { daysUntil } from "../../engine/bridge.ts";
import { useForecast } from "../forecast/useForecast.ts";
import { BillsSummary, whenText } from "./BillsSummary.tsx";
import "../entries/entries.css";
import "../auth/auth.css";

import { Button, Card, Illustration, List, ListRow } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Debt, RecurringSeries } from "../../data/db.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { CardSpending, CreditHabitsCard } from "../credit/CreditHabits.tsx";
import {
  canBeRegular,
  confirmSuggestion,
  dismissSuggestion,
  INTERVAL_LABELS,
  markAsBill,
  markAsRegular,
  suggestionInterval,
  useFoundRuns,
  useRecurringSeries,
} from "../forecast/useRecurring.ts";
import { useSubscriptions } from "../subscriptions/useSubscriptions.ts";
import { AdjustBillsSheet } from "./AdjustBillsSheet.tsx";
import { BillSheet } from "./BillSheet.tsx";
import { CardDebtSheet } from "./CardDebtSheet.tsx";
import { ConsolidationCalc } from "./ConsolidationCalc.tsx";
import { DebtList } from "./DebtList.tsx";
import { DebtSheet } from "./DebtSheet.tsx";
import { usePlanDebts } from "./debtPlan.ts";
import { LinkedCards } from "./LinkedCards.tsx";
import { PayoffPlan } from "./PayoffPlan.tsx";

/**
 * Bills & debt (mockup F5Bills): suggestions found in statements, the confirmed bills and
 * expected income that feed Upcoming and the forecast, add and edit by hand. The Debt payoff
 * tab lists cards and loans in the person's order (`debt.order`); nothing is moved for you.
 */
export function BillsScreen() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  // Home's Debt-free card opens the Debt payoff tab (`/bills?tab=debt`).
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"bills" | "debt">(params.get("tab") === "debt" ? "debt" : "bills");
  const found = useFoundRuns(today);
  const suggestions = found?.offered;
  const regular = found?.regular ?? [];
  const series = useRecurringSeries("confirmed");
  // At a glance (October 23, 2026): the next 30 days from the forecast, and each bill's countdown.
  const forecast = useForecast(today);
  const [nextIn, setNextIn] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!series) return;
    let alive = true;
    void Promise.all(
      series.map(async (s) => [s.id, await daysUntil(today, s.next_date)] as const),
    ).then((pairs) => {
      if (alive) setNextIn(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [series, today]);
  const [editing, setEditing] = useState<RecurringSeries | "new" | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [editingDebt, setEditingDebt] = useState<Debt | "new" | null>(null);
  const [cardFor, setCardFor] = useState<string | null>(null);
  const planDebts = usePlanDebts();
  const openCard = planDebts?.cards.find((c) => c.account.id === cardFor) ?? null;

  return (
    <>
      <ScreenHeader
        title="Bills & debt"
        back="/forecast"
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => (tab === "debt" ? setEditingDebt("new") : setEditing("new"))}
          >
            + Add
          </Button>
        }
      />
      <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
        <legend className="sr-only">Show</legend>
        {(
          [
            ["bills", "Bills"],
            ["debt", "Debt payoff"],
          ] as const
        ).map(([value, label]) => (
          <label className="segmented__option" key={value}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-tab`}
              value={value}
              checked={tab === value}
              onChange={() => setTab(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {tab === "debt" ? (
        <>
          <CreditHabitsCard />
          <LinkedCards />
          <CardSpending />
          <PayoffPlan />
          <p className="sk-card__eyebrow">
            <Link to="/what-if?lever=loan">What if I put more on one loan?</Link>
          </p>
          <ConsolidationCalc />
          <DebtList onEdit={(d) => setEditingDebt(d)} onCard={setCardFor} />
        </>
      ) : (
        <>
          {suggestions?.map((s) => (
            <Card
              className="suggestion"
              as="section"
              aria-label={`Suggestion: ${s.label}`}
              key={`${s.payee}:${s.kind}`}
            >
              <p className="sk-card__eyebrow">Looks recurring · found in your history</p>
              <div className="goal-card__top">
                <span className="goal-card__title">
                  {s.label} · {formatCents(s.expected_cents)}{" "}
                  {suggestionInterval(s.interval).toLowerCase()}
                </span>
                <span className="up-row__kind">next ~{formatDay(s.next_date)}</span>
              </div>
              <div className="suggestion__actions">
                <Button onClick={() => confirmSuggestion(db, s)}>
                  {s.kind === "income" ? "Yes, it's income" : "Yes, it's a bill"}
                </Button>
                <Button variant="secondary" onClick={() => dismissSuggestion(db, s)}>
                  {s.kind === "income" ? "Not income" : "Not a bill"}
                </Button>
                {canBeRegular(s) ? (
                  <Button variant="secondary" onClick={() => markAsRegular(db, s)}>
                    This is regular spending
                  </Button>
                ) : null}
              </div>
            </Card>
          ))}
          {regular.length > 0 ? (
            <Card as="section" aria-labelledby="bills-regular">
              <p className="sk-card__eyebrow">Found in your history</p>
              <Word>Regular</Word>
              <h2 className="sk-card__title" id="bills-regular">
                Regular spending, not bills
              </h2>
              <p>Everyday spending on a schedule. It stays in your usual spending.</p>
              <ul className="regular-list" aria-label="Regular spending">
                {regular.map((s) => (
                  <li key={`${s.payee}:${s.kind}`} className="regular-row">
                    <span>
                      <strong>{s.label}</strong> · {formatCents(s.expected_cents)}{" "}
                      {suggestionInterval(s.interval).toLowerCase()}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`${s.label}: this is a bill`}
                      onClick={() => markAsBill(db, s)}
                    >
                      This is a bill
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {series && series.length === 0 ? (
            <Card>
              <Illustration name="calendar" tone="a1" />
              <Word>None</Word>
              <p>No bills yet. Confirm the ones Qash finds, or tap + Add.</p>
            </Card>
          ) : null}
          {forecast.upcoming ? (
            <BillsSummary
              today={today}
              items={forecast.upcoming.items}
              labelFor={(item) => forecast.series.get(item.series_id)?.label ?? item.payee}
            />
          ) : null}
          {series?.some((s) => s.kind === "bill") ? <SubscriptionsLink today={today} /> : null}
          {series && series.length > 0 ? (
            <List card aria-label="Bills and income">
              {series.map((s) => (
                <ListRow
                  key={s.id}
                  leading={
                    <span className={`bill-badge bill-badge--${s.kind}`} aria-hidden="true">
                      {s.kind === "income" ? "↑" : "↓"}
                    </span>
                  }
                  label={s.label}
                  sublabel={`${INTERVAL_LABELS[s.interval]} · ${
                    nextIn.has(s.id)
                      ? `${whenText(nextIn.get(s.id) ?? 0)}, ${formatDay(s.next_date)}`
                      : formatDay(s.next_date)
                  }`}
                  value={formatCents(s.expected_cents, s.kind === "income" ? "in" : "out")}
                  valueTone={s.kind === "income" ? "success" : "default"}
                  onClick={() => setEditing(s)}
                />
              ))}
            </List>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => setAdjusting(true)}>
            Adjust bills
          </Button>
          <p className="auth__fineprint">
            Bills feed your upcoming-expense alerts and 30-day forecast.
          </p>
        </>
      )}
      <AdjustBillsSheet open={adjusting} onClose={() => setAdjusting(false)} />
      <BillSheet
        open={editing !== null}
        series={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
      />
      <DebtSheet
        open={editingDebt !== null}
        debt={editingDebt === "new" ? null : editingDebt}
        onClose={() => setEditingDebt(null)}
      />
      <CardDebtSheet
        card={openCard}
        unpaired={planDebts?.unpaired ?? []}
        onClose={() => setCardFor(null)}
      />
    </>
  );
}

/** The way into Subscriptions from Bills: what they cost a year, one tap away. */
function SubscriptionsLink({ today }: { today: string }) {
  const view = useSubscriptions(today);
  const count = view?.subscriptions.length ?? 0;
  return (
    <Card>
      <Link to="/subscriptions" className="auth__link">
        Subscriptions
      </Link>{" "}
      <span className="sk-card__eyebrow">
        {!view
          ? ""
          : count === 0
            ? "· none counted yet"
            : `· ${count} · ${formatCents(view.totals.yearly_cents)} a year`}
      </span>
    </Card>
  );
}
