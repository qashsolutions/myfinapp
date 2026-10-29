import "./fixed.css";

import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { Category } from "../../data/db.ts";
import type { FixedFlexible } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { useLookups } from "../entries/useEntries.ts";
import { InsightCard } from "../insights/InsightCard.tsx";
import { type FixedFlexibleView, useFixedFlexible } from "./useFixedFlexible.ts";

export const FIXED_PATH = "/insights/fixed-flexible";

/** "11% kept": the kept rate as a whole percent (display only; the engine gives bps). */
export function keptRateText(result: FixedFlexible): string {
  if (result.kept_rate_bps === null)
    return result.kept_cents < 0
      ? `${formatCents(-result.kept_cents)} over`
      : `${formatCents(result.kept_cents)} kept`;
  return `${Math.round(result.kept_rate_bps / 100)}% kept`;
}

export function categoryName(
  id: string | null,
  categories: Map<string, Category> | undefined,
): string {
  if (id === null) return "Uncategorized";
  return categories?.get(id)?.name ?? "Uncategorized";
}

/** "Most room: Dining $310, Shopping $190": the largest flexible wants, up to two. */
export function roomText(
  result: FixedFlexible,
  categories: Map<string, Category> | undefined,
): string | null {
  const top = result.room.slice(0, 2);
  if (top.length === 0) return null;
  return `Most room: ${top
    .map((r) => `${categoryName(r.category_id, categories)} ${formatCents(r.flexible_cents)}`)
    .join(", ")}`;
}

/** Fixed, then flexible, with flexible wants marked as room; widths are shares of money out. */
export function FixedBar({ result }: { result: FixedFlexible }) {
  const total = Math.max(result.fixed_cents + result.flexible_cents, 1);
  const room = Math.max(result.flexible_by_bucket.want, 0);
  const otherFlexible = Math.max(result.flexible_cents - room, 0);
  const pct = (cents: number) => `${(Math.max(cents, 0) / total) * 100}%`;
  return (
    <div className="fixed-bar" aria-hidden="true">
      <span
        className="fixed-bar__seg fixed-bar__seg--fixed"
        style={{ width: pct(result.fixed_cents) }}
      />
      <span className="fixed-bar__seg fixed-bar__seg--flex" style={{ width: pct(otherFlexible) }} />
      <span className="fixed-bar__seg fixed-bar__seg--room" style={{ width: pct(room) }} />
    </div>
  );
}

export function FixedKey() {
  return (
    <span className="fixed-key" aria-hidden="true">
      <span className="fixed-key__fixed">Fixed</span>
      <span className="fixed-key__flex">Flexible</span>
      <span className="fixed-key__room">Wants (room)</span>
    </span>
  );
}

function line(result: FixedFlexible): string {
  return `${keptRateText(result)} · fixed ${formatCents(result.fixed_cents)} · flexible ${formatCents(result.flexible_cents)}`;
}

/** The Insights card (INSIGHT_CARDS "fixed"). */
export function FixedFlexibleInsight({ today }: { today: string }) {
  const view = useFixedFlexible(today, today);
  const lookups = useLookups();
  return (
    <InsightCard
      title="Fixed vs flexible"
      to={FIXED_PATH}
      word={view?.word ?? "Start"}
      line={view && view.word !== "Start" ? line(view.current) : "Ready when you add spending"}
    >
      {view && view.word !== "Start" ? (
        <FixedVisual view={view} categories={lookups?.categories} />
      ) : null}
    </InsightCard>
  );
}

function FixedVisual({
  view,
  categories,
}: {
  view: FixedFlexibleView;
  categories: Map<string, Category> | undefined;
}) {
  const room = roomText(view.current, categories);
  return (
    <>
      <FixedBar result={view.current} />
      <FixedKey />
      {room ? <span className="fixed-room">{room}</span> : null}
    </>
  );
}

/** Money in & out's month card (MONEY_CARDS "fixed"), for the month on screen. */
export function FixedFlexibleMonthCard({ asOf, today }: { asOf: string; today: string }) {
  const view = useFixedFlexible(asOf, today);
  const lookups = useLookups();
  if (!view || view.word === "Start") return null;
  return (
    <Card as="section" aria-labelledby="money-fixed">
      <h2 className="sk-card__title" id="money-fixed">
        Fixed vs flexible
      </h2>
      <Word>{view.word}</Word>
      <p className="fixed-line">{line(view.current)}</p>
      <FixedVisual view={view} categories={lookups?.categories} />
      <p className="fixed-more">
        <Link to={`${FIXED_PATH}?month=${asOf}`} className="auth__link">
          Each category, fixed and flexible
        </Link>
      </p>
    </Card>
  );
}
