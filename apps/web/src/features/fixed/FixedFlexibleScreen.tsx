import "./fixed.css";
import "../insights/insights.css";

import { Button, Card } from "@stackd/ui";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useLookups } from "../entries/useEntries.ts";
import { FixedAdjustSheet } from "./FixedAdjustSheet.tsx";
import { categoryName } from "./FixedFlexibleCard.tsx";
import { FixedDonut, KeptTrend } from "./FixedVisuals.tsx";
import { roomAmount, roomWhatIfLink } from "./room.ts";
import { useFixedFlexible, useFixedOverrides } from "./useFixedFlexible.ts";

/** "Most room" stays the two largest flexible wants (signed off by the owner, October 29, 2026). */
const ROOM_SHOWN = 2;

const BUCKET_NAMES: Record<string, string> = {
  need: "Needs",
  want: "Wants",
  save: "Save",
  none: "No bucket",
};

/**
 * Fixed vs flexible (docs/spec.md, October 28, 2026): money out that belongs to a confirmed bill
 * or subscription against the rest, each category's split, and the kept rate for this month so
 * far and the 3 months before, all from `cashflow.fixed_flexible`. Facts, never advice.
 */
export function FixedFlexibleScreen() {
  const today = todayIso();
  const [params, setParams] = useSearchParams();
  const [adjust, setAdjust] = useState(params.get("adjust") === "1");
  const overrides = useFixedOverrides();
  const asked = params.get("month");
  const asOf =
    asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && compareText(asked, today) <= 0 ? asked : today;
  const view = useFixedFlexible(asOf, today);
  const lookups = useLookups();
  const current = view?.current;
  const closeAdjust = () => {
    setAdjust(false);
    if (params.has("adjust")) {
      params.delete("adjust");
      setParams(params, { replace: true });
    }
  };

  return (
    <>
      <ScreenHeader
        title="Fixed vs flexible"
        back="/insights"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdjust(true)}>
            Adjust
          </Button>
        }
      />
      {!view || !current ? (
        <p className="range-note">Adding it up…</p>
      ) : view.word === "Start" ? (
        <Card>
          <Word>Start</Word>
          <p>Nothing in or out in {formatMonth(asOf)} yet.</p>
        </Card>
      ) : (
        <>
          <Card as="section" aria-label={`${formatMonth(asOf)}, fixed vs flexible`}>
            <Word>{view.word}</Word>
            <p className="fixed-line">Bills against everything else you spent</p>
            <FixedDonut result={current} label={formatMonth(asOf)} />
            <dl className="fixed-totals">
              <div>
                <dt>Kept</dt>
                <dd className={current.kept_cents < 0 ? "insight-neg" : undefined}>
                  {formatCents(current.kept_cents)}
                </dd>
              </div>
              <div>
                <dt>In</dt>
                <dd>{formatCents(current.in_cents)}</dd>
              </div>
              <div>
                <dt>Out</dt>
                <dd>{formatCents(current.out_cents)}</dd>
              </div>
            </dl>
          </Card>

          {current.room.length ? (
            <section aria-labelledby="fixed-room">
              <h2 className="range-h" id="fixed-room">
                Most room
              </h2>
              <Card>
                <p className="fixed-line">Flexible wants, largest first. Tap one to try it.</p>
                <ul className="fixed-room-list">
                  {current.room.slice(0, ROOM_SHOWN).map((r) =>
                    r.category_id ? (
                      <li key={r.category_id}>
                        <Link
                          to={roomWhatIfLink(r.category_id, r.flexible_cents)}
                          aria-label={`${categoryName(r.category_id, lookups?.categories)} ${formatCents(r.flexible_cents)}: try ${formatCents(roomAmount(r.flexible_cents))} less a month in What if`}
                        >
                          <span className="fixed-room-list__name">
                            {categoryName(r.category_id, lookups?.categories)}
                          </span>
                          <span>{formatCents(r.flexible_cents)}</span>
                          <span className="fixed-room-list__try" aria-hidden="true">
                            Try ›
                          </span>
                        </Link>
                      </li>
                    ) : null,
                  )}
                </ul>
              </Card>
            </section>
          ) : null}

          <section aria-labelledby="fixed-months">
            <h2 className="range-h" id="fixed-months">
              Kept rate by month
            </h2>
            <Card>
              <KeptTrend months={view.months} highlight={current.start} />
            </Card>
          </section>

          <section aria-labelledby="fixed-buckets">
            <h2 className="range-h" id="fixed-buckets">
              By bucket
            </h2>
            <Card>
              <table className="fixed-table">
                <thead>
                  <tr>
                    <th scope="col">Bucket</th>
                    <th scope="col">Fixed</th>
                    <th scope="col">Flexible</th>
                  </tr>
                </thead>
                <tbody>
                  {(["need", "want", "save", "none"] as const)
                    .filter((b) => current.fixed_by_bucket[b] || current.flexible_by_bucket[b])
                    .map((b) => (
                      <tr key={b}>
                        <th scope="row">{BUCKET_NAMES[b]}</th>
                        <td>{formatCents(current.fixed_by_bucket[b])}</td>
                        <td>{formatCents(current.flexible_by_bucket[b])}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          </section>

          <section aria-labelledby="fixed-categories">
            <h2 className="range-h" id="fixed-categories">
              Each category
            </h2>
            <Card>
              <table className="fixed-table">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Fixed</th>
                    <th scope="col">Flexible</th>
                  </tr>
                </thead>
                <tbody>
                  {current.by_category
                    .filter((c) => c.out_cents !== 0 || c.fixed_cents !== 0)
                    .map((c) => (
                      <tr key={c.category_id ?? "none"}>
                        <th scope="row">{categoryName(c.category_id, lookups?.categories)}</th>
                        <td>{formatCents(c.fixed_cents)}</td>
                        <td>{formatCents(c.flexible_cents)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          </section>
        </>
      )}
      <p className="auth__fineprint">
        Fixed is money out on bills and subscriptions you confirmed; flexible is everything else you
        spent. Kept rate is what you kept of what came in. From your own entries on this device;
        transfers and "Don't count" entries are left out. Adjust sets a category fixed or flexible
        by your own call.
      </p>
      <FixedAdjustSheet
        open={adjust}
        onClose={closeAdjust}
        result={current}
        overrides={overrides}
        categories={lookups?.categories}
      />
    </>
  );
}
