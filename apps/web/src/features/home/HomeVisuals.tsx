import type { Bucket, Category } from "../../data/db.ts";
import type { MonthTotals } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

/**
 * Home's pictures (October 19, 2026): read at a glance, numbers beside the shapes, colours from
 * the tokens only. Widths are display arithmetic; every amount itself comes from the engine.
 */

/** In vs out on the accent hero: two bars, the longer one full width. */
export function HeroBars({ inCents, outCents }: { inCents: number; outCents: number }) {
  const max = Math.max(inCents, outCents, 1);
  return (
    <div className="hero-bars" aria-hidden="true">
      {(
        [
          ["In", inCents, "in"],
          ["Out", outCents, "out"],
        ] as const
      ).map(([label, cents, kind]) => (
        <div className="hero-bars__row" key={kind}>
          <span className="hero-bars__label">{label}</span>
          <span className="hero-bars__track">
            <span
              className={`hero-bars__fill hero-bars__fill--${kind}`}
              style={{ width: `${Math.max(2, (cents / max) * 100)}%` }}
            />
          </span>
          <span className="hero-bars__value">{formatCents(cents)}</span>
        </div>
      ))}
    </div>
  );
}

const BUCKET_CLASS: Record<Bucket, string> = { need: "need", want: "want", save: "save" };

/** Where the month's money went: the top categories as bars, coloured by need / want / save. */
export function CategoryBars({
  byCategory,
  categories,
  limit = 5,
}: {
  byCategory: MonthTotals["by_category"];
  categories: Map<string, Category> | undefined;
  limit?: number;
}) {
  const rows = byCategory
    .filter((c) => c.out_cents > 0)
    .sort((a, b) => b.out_cents - a.out_cents)
    .slice(0, limit);
  if (rows.length === 0) return null;
  const max = rows[0]?.out_cents ?? 1;
  return (
    <ul className="cat-bars" aria-label="Top spending categories">
      {rows.map((r) => {
        const cat = r.category_id ? categories?.get(r.category_id) : undefined;
        const tone = cat?.bucket ? BUCKET_CLASS[cat.bucket] : "none";
        const name = cat?.name ?? "Not sorted yet";
        return (
          <li className="cat-bars__row" key={r.category_id ?? "none"}>
            <span className="cat-bars__name">{name}</span>
            <span className="cat-bars__track" aria-hidden="true">
              <span
                className={`cat-bars__fill cat-bars__fill--${tone}`}
                style={{ width: `${Math.max(3, (r.out_cents / max) * 100)}%` }}
              />
            </span>
            <span className="cat-bars__value">{formatCents(r.out_cents)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The need / want / save colour key under the category bars. */
export function BucketKey() {
  return (
    <p className="bucket-key" aria-hidden="true">
      <span className="bucket-key__dot bucket-key__dot--need" /> Needs
      <span className="bucket-key__dot bucket-key__dot--want" /> Wants
      <span className="bucket-key__dot bucket-key__dot--save" /> Saving
    </p>
  );
}
