import "../home/home.css";
import "../entries/entries.css";
import "../auth/auth.css";
import "../forecast/forecast.css";
import "../goals/goals.css";

import { Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { useLookups } from "../entries/useEntries.ts";
import { useForecast } from "../forecast/useForecast.ts";
import { newMoneyIn, useGoals } from "../goals/useGoals.ts";
import { CategoryBars, HeroBars } from "../home/HomeVisuals.tsx";
import { useWeekTotals } from "./useWeekTotals.ts";

/**
 * The weekly recap (fast-follow 6): the seven days ending today, from the device's own
 * entries. The push and the email only say "your recap is ready" and open this screen;
 * every number here is computed on the device.
 */
export function WeeklyRecap() {
  const asOf = todayIso();
  const week = useWeekTotals(asOf);
  const lookups = useLookups();
  const goals = useGoals();
  const { db } = useDb();
  const deposits = useLiveQuery(
    async () =>
      week.start
        ? newMoneyIn(
            await db.goal_events
              .filter((e) => e.date >= (week.start as string) && e.date <= asOf)
              .toArray(),
          )
        : undefined,
    [db, week.start, asOf],
  );

  const totals = week.totals;
  const hasEntries = (week.entries?.length ?? 0) > 0;
  const topCategories = (totals?.by_category ?? []).filter((c) => c.out_cents > 0).slice(0, 3);
  const activeGoals = (goals ?? []).filter((g) => g.status === "active");
  const jarsWithDeposits = new Map<string, number>();
  let setAside = 0;
  for (const d of deposits ?? []) {
    const cents = d.amount_cents ?? 0;
    setAside += cents;
    jarsWithDeposits.set(d.goal_id, (jarsWithDeposits.get(d.goal_id) ?? 0) + cents);
  }
  const biggestDeposit = Math.max(1, ...jarsWithDeposits.values());
  // The next week's bills and paydays, from the forecast (October 23, 2026).
  const forecast = useForecast(asOf);
  const comingUp = (forecast.upcoming?.items ?? []).filter((i) => !i.matched).slice(0, 4);
  const range = week.start ? `${formatDay(week.start)} – ${formatDay(asOf)}` : "";

  return (
    <>
      <ScreenHeader eyebrow={range} title="Your week" back="/" actions={null} />
      <Card tone="accent" as="section" aria-labelledby="recap-week">
        <p className="sk-card__eyebrow" id="recap-week">
          The last 7 days
        </p>
        {totals && hasEntries ? (
          <>
            <Word className="home__hero-word">{totals.net_cents < 0 ? "Over" : "Kept"}</Word>
            {/* In green, Out red, as on Home (October 23, 2026). */}
            <HeroBars inCents={totals.in_cents} outCents={totals.out_cents} />
            <p className="home__numbers">
              <span>Got {formatCents(totals.in_cents)}</span>
              <span aria-hidden="true">·</span>
              <span>Spent {formatCents(totals.out_cents)}</span>
              <span aria-hidden="true">·</span>
              <span>Kept {formatCents(totals.net_cents)}</span>
            </p>
            <p className="home__verdict" role="status">
              {totals.net_cents >= 0
                ? `You spent less than you got. ${formatCents(totals.net_cents)} is yours to keep.`
                : `You spent ${formatCents(-totals.net_cents)} more than you got.`}
            </p>
            {week.delta !== null && week.previous && week.previous.count > 0 ? (
              <p className="auth__hint">
                {week.delta === 0
                  ? "Same as the week before."
                  : week.delta > 0
                    ? `vs the week before: you kept ${formatCents(week.delta)} more.`
                    : `vs the week before: you kept ${formatCents(-week.delta)} less.`}
              </p>
            ) : null}
          </>
        ) : week.entries ? (
          <p>
            Nothing logged these 7 days yet.{" "}
            <Link to="/add" className="auth__link">
              Add an entry
            </Link>{" "}
            or{" "}
            <Link to="/import" className="auth__link">
              import a statement
            </Link>
            .
          </p>
        ) : (
          <p className="sr-only" role="status">
            Loading
          </p>
        )}
      </Card>

      {topCategories.length > 0 ? (
        <Card as="section" aria-labelledby="recap-where">
          <p className="sk-card__eyebrow" id="recap-where">
            Where it went
          </p>
          <Word>Spent</Word>
          <CategoryBars byCategory={topCategories} categories={lookups?.categories} limit={3} />
          {totals && totals.by_category.length > 3 ? (
            <Link to="/money" className="auth__link">
              All categories in Money in &amp; out
            </Link>
          ) : null}
        </Card>
      ) : null}

      <Card as="section" aria-labelledby="recap-jars">
        <p className="sk-card__eyebrow" id="recap-jars">
          Jars
        </p>
        <Word>{deposits && deposits.length > 0 ? "Saved" : "Quiet"}</Word>
        {deposits && deposits.length > 0 ? (
          <>
            <p>
              You set aside <strong>{formatCents(setAside)}</strong> in{" "}
              {deposits.length === 1 ? "one deposit" : `${deposits.length} deposits`}.
            </p>
            <ul className="recap__list">
              {[...jarsWithDeposits.entries()].map(([goalId, cents]) => (
                <li key={goalId} className="recap__jar">
                  <span className="hero-split">
                    <Link to={`/goals/${goalId}`} className="auth__link">
                      {(goals ?? []).find((g) => g.id === goalId)?.title ?? "A jar"}
                    </Link>
                    <span>{formatCents(cents)}</span>
                  </span>
                  <span className="goal-row__bar" aria-hidden="true">
                    <span
                      className="goal-row__fill goal-row__fill--done"
                      style={{ width: `${Math.max(4, (cents / biggestDeposit) * 100)}%` }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            No deposits these 7 days.{" "}
            {activeGoals.length > 0 ? (
              <Link to="/goals" className="auth__link">
                {activeGoals.length === 1
                  ? "Your jar is waiting"
                  : `${activeGoals.length} jars are waiting`}
              </Link>
            ) : (
              <Link to="/goals/new" className="auth__link">
                Start a jar
              </Link>
            )}
            .
          </p>
        )}
      </Card>

      <Card as="section" aria-labelledby="recap-next">
        <p className="sk-card__eyebrow" id="recap-next">
          Coming up
        </p>
        <Word>{comingUp.length > 0 ? "Upcoming" : "Clear"}</Word>
        {comingUp.length > 0 ? (
          <ul className="recap__list">
            {comingUp.map((item) => (
              <li key={`${item.series_id}:${item.date}`} className="recap__next">
                <span className={`bill-badge bill-badge--${item.kind}`} aria-hidden="true">
                  {item.kind === "income" ? "↑" : "↓"}
                </span>
                <span className="recap__next-label">
                  {forecast.series.get(item.series_id)?.label ?? item.payee}
                  <span className="recap__next-date">{formatDay(item.date)}</span>
                </span>
                <span
                  className={
                    item.kind === "income" ? "entry-amount entry-amount--in" : "entry-amount"
                  }
                >
                  {formatCents(item.amount_cents, item.kind === "income" ? "in" : "out")}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          <Link to="/forecast" className="auth__link">
            See the next 30 days
          </Link>
          : expected bills, paydays and your estimated balance.
        </p>
      </Card>
      <p className="auth__fineprint">
        Transfers are left out; refunds count against their category. Stays on this phone.
      </p>
    </>
  );
}
