import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { growthProjection, type NetWorthSummary } from "../../engine/bridge.ts";
import { formatCents, formatWholeDollars } from "../../lib/format.ts";
import { useLaterPlan } from "../later/useLaterPlan.ts";

/**
 * How reachable what you own is (owner decision, November 16, 2026): cash is ready now,
 * investments take days to sell, retirement money usually costs tax and a penalty before
 * retirement age, and a home or car isn't spending money. From the summary's group totals.
 */
export const REACH = [
  { key: "cash", label: "Cash", note: "Ready now", groups: ["cash", "savings"] },
  { key: "investments", label: "Investments", note: "A few days to sell", groups: ["investments"] },
  {
    key: "retirement",
    label: "Retirement",
    note: "Usually tax and a penalty if taken early",
    groups: ["retirement"],
  },
  {
    key: "other",
    label: "Home, car and other",
    note: "Not spending money",
    groups: ["property", "vehicle", "other_asset"],
  },
] as const;

export function reachOf(summary: NetWorthSummary): { key: string; cents: number }[] {
  return REACH.map((r) => ({
    key: r.key,
    cents: summary.groups
      .filter((g) => g.kind === "asset" && (r.groups as readonly string[]).includes(g.group))
      .reduce((n, g) => n + g.total_cents, 0),
  }));
}

export function ReachCard({ summary }: { summary: NetWorthSummary }) {
  const parts = reachOf(summary);
  const total = parts.reduce((n, p) => n + p.cents, 0);
  if (total <= 0) return null;
  const within = (parts[0]?.cents ?? 0) + (parts[1]?.cents ?? 0);
  return (
    <Card as="section" aria-label="What you could reach" className="worth-reach">
      <Word>{within > 0 ? "Ready" : "None"}</Word>
      <p className="worth-reach__line">
        {within > 0
          ? `${formatCents(within)} in cash and investments, within days`
          : "No cash or investments counted yet"}
      </p>
      <div className="worth-reach__bar" aria-hidden="true">
        {parts.map((p) =>
          p.cents > 0 ? (
            <span
              key={p.key}
              className={`worth-reach__seg worth-reach__seg--${p.key}`}
              style={{ flexGrow: p.cents }}
            />
          ) : null,
        )}
      </div>
      <ul className="worth-reach__list">
        {REACH.map((r, i) => {
          const cents = parts[i]?.cents ?? 0;
          if (cents <= 0) return null;
          return (
            <li key={r.key}>
              <span className={`worth-reach__dot worth-reach__seg--${r.key}`} aria-hidden="true" />
              <span className="worth-reach__name">
                {r.label}
                <span className="worth-reach__note">{r.note}</span>
              </span>
              <span className="worth-reach__value">{formatCents(cents)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** The years the Ahead card shows. */
export const AHEAD_YEARS = [1, 3, 5, 10] as const;

export interface AheadPoint {
  years: number;
  /** Net worth at the low, middle and high rate. */
  net_cents: [number, number, number];
}

/**
 * Net worth ahead (owner decision, November 16, 2026): investments and retirement grow at the
 * person's own Later rates (growth.projection, monthly, from today's total with nothing added),
 * everything else stays as it is today. An illustration, not a prediction.
 */
export function useAhead(summary: NetWorthSummary | null): {
  points: AheadPoint[] | null;
  rates: [number, number, number] | null;
  invested: number;
} {
  const [plan] = useLaterPlan();
  const [points, setPoints] = useState<AheadPoint[] | null>(null);
  const parts = summary ? reachOf(summary) : [];
  const invested = (parts[1]?.cents ?? 0) + (parts[2]?.cents ?? 0);
  const net = summary?.net_cents ?? 0;
  const rates = plan?.rates_bps ?? null;
  const ratesKey = rates?.join(",") ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: rates are compared by value (ratesKey)
  useEffect(() => {
    if (!summary || !rates || invested <= 0) {
      setPoints(null);
      return;
    }
    let alive = true;
    const horizon = AHEAD_YEARS[AHEAD_YEARS.length - 1] ?? 10;
    // Ages only count the years here; the rule needs some, so these span the horizon.
    void growthProjection({
      age_now: 30,
      retire_age: 30 + horizon,
      start_cents: invested,
      monthly_cents: 0,
      rates_bps: [...rates],
      target_cents: 0,
    })
      .then((p) => {
        if (!alive) return;
        const rest = net - invested;
        setPoints(
          AHEAD_YEARS.map((y) => {
            const b = p.points[y]?.balances_cents ?? [invested, invested, invested];
            return {
              years: y,
              net_cents: [rest + (b[0] ?? 0), rest + (b[1] ?? 0), rest + (b[2] ?? 0)] as [
                number,
                number,
                number,
              ],
            };
          }),
        );
      })
      .catch(() => {
        if (alive) setPoints(null);
      });
    return () => {
      alive = false;
    };
  }, [summary, invested, net, ratesKey]);
  return { points, rates, invested };
}

/** Whole dollars with the sign: a net worth can be below zero. */
const dollars = (cents: number) => `${cents < 0 ? "−" : ""}${formatWholeDollars(cents)}`;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

export function AheadCard({ summary }: { summary: NetWorthSummary }) {
  const { points, rates, invested } = useAhead(summary);
  if (invested <= 0)
    return (
      <Card as="section" aria-label="Net worth ahead" className="worth-ahead">
        <Word>Start</Word>
        <p className="worth-ahead__line">
          Add investments or retirement to see how they could grow.
        </p>
      </Card>
    );
  if (!points || !rates) return null;
  const top = Math.max(...points.map((p) => p.net_cents[2]), 1);
  const last = points[points.length - 1];
  return (
    <Card as="section" aria-label="Net worth ahead" className="worth-ahead">
      <Word>Growing</Word>
      <p className="worth-ahead__line">
        {last ? `${dollars(last.net_cents[1])} in ${last.years} years at ${pct(rates[1])}` : ""}
      </p>
      <ul className="worth-ahead__rows">
        {points.map((p) => (
          <li key={p.years}>
            <span className="worth-ahead__when">
              {p.years} {p.years === 1 ? "year" : "years"}
            </span>
            <span className="worth-ahead__track" aria-hidden="true">
              <span
                className="worth-ahead__band"
                style={{
                  left: `${Math.max(0, (p.net_cents[0] / top) * 100)}%`,
                  width: `${Math.max(0, ((p.net_cents[2] - p.net_cents[0]) / top) * 100)}%`,
                }}
              />
              <span
                className="worth-ahead__mid"
                style={{ left: `${Math.max(0, Math.min(100, (p.net_cents[1] / top) * 100))}%` }}
              />
            </span>
            <span className="worth-ahead__value">
              {dollars(p.net_cents[1])}
              <span className="worth-ahead__range">
                {dollars(p.net_cents[0])} to {dollars(p.net_cents[2])}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="worth-ahead__note">
        Investments and retirement grow at {pct(rates[0])}, {pct(rates[1])} or {pct(rates[2])} a
        year, your rates in <Link to="/insights/later">Later</Link>; cash, home, car and debts stay
        as they are. An illustration, not a prediction or advice.
      </p>
    </Card>
  );
}
