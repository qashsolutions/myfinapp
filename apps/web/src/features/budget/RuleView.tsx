import { Card, ProgressBar } from "@stackd/ui";
import { Word } from "../../app/layout/Word.tsx";
import type { Category } from "../../data/db.ts";
import type { Bucket, BudgetSummary } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { type Split, SUGGESTED } from "./split.ts";

export const BUCKET_LABELS: Record<Bucket, [string, string]> = {
  need: ["Needs", "50%"],
  want: ["Wants", "30%"],
  save: ["Save + pay down", "20%"],
};

/** The split view (mockup F5Budget): one card per bucket with spent of plan and over/left; each
 * bucket's share is the person's own split (50/30/20 unless they changed it). */
export function RuleView({
  summary,
  categories,
  split,
}: {
  summary: BudgetSummary;
  categories: Map<string, Category>;
  split?: Split | null;
}) {
  return (
    <>
      {summary.buckets.map((b) => {
        const [name] = BUCKET_LABELS[b.bucket];
        const pct = `${Math.round((split ?? SUGGESTED)[b.bucket] / 100)}%`;
        const over = b.left_cents < 0;
        const fraction =
          b.planned_cents > 0 ? b.spent_cents / b.planned_cents : b.spent_cents > 0 ? 1 : 0;
        const names = summary.categories
          .filter((c) => c.bucket === b.bucket && c.spent_cents !== 0)
          .map((c) => categories.get(c.category_id)?.name ?? "Unknown")
          .slice(0, 4);
        return (
          <Card as="section" key={b.bucket} aria-label={`${name} ${pct}`}>
            <Word>
              {b.bucket === "save"
                ? fraction >= 1
                  ? "Ahead"
                  : "Saving"
                : over
                  ? "Over"
                  : "Steady"}
            </Word>
            <div className="bucket__top">
              <span className="bucket__title">
                {name} · {pct}
              </span>
              <span className="bucket__spent">
                {formatCents(b.spent_cents)}{" "}
                <span className="bucket__of">of {formatCents(b.planned_cents)}</span>
              </span>
            </div>
            <ProgressBar
              fraction={fraction}
              label={`${name} spent`}
              valueText={`${formatCents(b.spent_cents)} of ${formatCents(b.planned_cents)}`}
              tone={over ? "danger" : fraction >= 1 ? "success" : "accent"}
            />
            <div className="bucket__bottom">
              <span>{names.length ? names.join(", ") : "Nothing yet"}</span>
              <span
                className={`bucket__status ${over ? "bucket__status--over" : "bucket__status--left"}`}
              >
                {over ? `${formatCents(-b.left_cents)} over` : `${formatCents(b.left_cents)} left`}
              </span>
            </div>
          </Card>
        );
      })}
    </>
  );
}
