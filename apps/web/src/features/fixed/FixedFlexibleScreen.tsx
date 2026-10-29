import "./fixed.css";
import "../insights/insights.css";

import { Card } from "@stackd/ui";
import { useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { formatCents, formatMonth, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useLookups } from "../entries/useEntries.ts";
import { categoryName, FixedBar, FixedKey, keptRateText, roomText } from "./FixedFlexibleCard.tsx";
import { useFixedFlexible } from "./useFixedFlexible.ts";

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
  const [params] = useSearchParams();
  const asked = params.get("month");
  const asOf =
    asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && compareText(asked, today) <= 0 ? asked : today;
  const view = useFixedFlexible(asOf, today);
  const lookups = useLookups();
  const current = view?.current;
  const maxRate = Math.max(
    1,
    ...(view?.months ?? []).map((m) => Math.abs(m.result.kept_rate_bps ?? 0)),
  );

  return (
    <>
      <ScreenHeader title="Fixed vs flexible" back="/insights" actions={null} />
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
            <p className="fixed-line">{keptRateText(current)} of what came in</p>
            <FixedBar result={current} />
            <FixedKey />
            <dl className="fixed-totals">
              <div>
                <dt>Fixed</dt>
                <dd>{formatCents(current.fixed_cents)}</dd>
              </div>
              <div>
                <dt>Flexible</dt>
                <dd>{formatCents(current.flexible_cents)}</dd>
              </div>
              <div>
                <dt>Kept</dt>
                <dd className={current.kept_cents < 0 ? "insight-neg" : undefined}>
                  {formatCents(current.kept_cents)}
                </dd>
              </div>
            </dl>
            {roomText(current, lookups?.categories) ? (
              <p className="fixed-room">{roomText(current, lookups?.categories)}</p>
            ) : null}
          </Card>

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

          <section aria-labelledby="fixed-months">
            <h2 className="range-h" id="fixed-months">
              Kept rate by month
            </h2>
            <Card>
              <ul className="fixed-months">
                {view.months.map(({ start, result }) => {
                  const bps = result.kept_rate_bps;
                  return (
                    <li key={start} className="fixed-months__row">
                      <span className="fixed-months__name">{formatMonth(start)}</span>
                      <span className="fixed-months__track" aria-hidden="true">
                        <span
                          className={`fixed-months__fill${bps !== null && bps < 0 ? " fixed-months__fill--neg" : ""}`}
                          style={{ width: `${(Math.abs(bps ?? 0) / maxRate) * 100}%` }}
                        />
                      </span>
                      <span className="fixed-months__value">
                        {bps === null ? "No money in" : `${Math.round(bps / 100)}%`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>
        </>
      )}
      <p className="auth__fineprint">
        Fixed is money out on bills and subscriptions you confirmed; flexible is everything else you
        spent. Kept rate is what you kept of what came in. From your own entries on this device;
        transfers and "Don't count" entries are left out.
      </p>
    </>
  );
}
