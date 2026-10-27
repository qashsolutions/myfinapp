import "../forecast/forecast.css";

import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { daysUntil, type UpcomingItem } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

/** "Today", "Tomorrow", "In 5 days". */
export function whenText(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

/**
 * The top of Bills (October 23, 2026): what's due in the next 30 days at a glance, and a strip of
 * the month ahead with a red dot per bill and a green dot per payday, from the forecast's own
 * upcoming list. Opens Next 30 days for the calendar.
 */
export function BillsSummary({
  today,
  items,
  labelFor,
}: {
  today: string;
  items: UpcomingItem[];
  labelFor: (item: UpcomingItem) => string;
}) {
  const [days, setDays] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      items.map(async (i) => [`${i.series_id}:${i.date}`, await daysUntil(today, i.date)] as const),
    ).then((pairs) => {
      if (alive) setDays(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [items, today]);
  const due = items.filter((i) => i.kind === "bill" && !i.matched);
  if (due.length === 0 || !days) return null;
  const total = due.reduce((sum, i) => sum + i.amount_cents, 0);
  const next = due[0] as UpcomingItem;
  const nextIn = days.get(`${next.series_id}:${next.date}`) ?? 0;
  return (
    <Card as="section" aria-label="Next 30 days of bills" className="bills-summary">
      <p className="sk-card__eyebrow">Next 30 days</p>
      <Word>Upcoming</Word>
      <p className="bills-summary__total">{formatCents(total)} in bills</p>
      <p className="bills-summary__line">
        {due.length} {due.length === 1 ? "bill" : "bills"} · next: {labelFor(next)}{" "}
        {whenText(nextIn).toLowerCase()}
      </p>
      <div className="bills-strip" role="img" aria-label="Bills and paydays over the next 30 days">
        {items.map((i) => {
          const d = days.get(`${i.series_id}:${i.date}`) ?? 0;
          return (
            <span
              key={`${i.series_id}:${i.date}`}
              className={`bills-strip__dot bills-strip__dot--${i.kind}${i.matched ? " bills-strip__dot--paid" : ""}`}
              style={{ left: `${Math.min(100, Math.max(0, (d / 30) * 100))}%` }}
            />
          );
        })}
      </div>
      <div className="bills-strip__axis" aria-hidden="true">
        <span>Today</span>
        <span>30 days</span>
      </div>
      <Link to="/forecast" className="auth__link">
        See them on a calendar
      </Link>
    </Card>
  );
}
