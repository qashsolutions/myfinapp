import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { formatCents } from "../../lib/format.ts";
import { myBalance, namesOf, useSplits, useSplitViews } from "./useSplits.ts";

/**
 * Home's `owed` card (spec "Split bills" → Where): "Owed +$68" / "Owe $18" across every group,
 * with the biggest payment that involves me. Hidden with no groups or when everyone's settled.
 */
export function OwedHomeCard() {
  const { splits } = useSplits({ background: true });
  const views = useSplitViews(splits?.groups ?? null);
  if (!splits || splits.groups.length === 0) return null;
  let total = 0;
  let top: { text: string; cents: number } | null = null;
  for (const g of splits.groups) {
    const view = views.get(g.id);
    total += myBalance(view, g);
    const nameOf = namesOf(g);
    for (const p of view?.payments ?? []) {
      if (p.from !== g.my_member_id && p.to !== g.my_member_id) continue;
      if (top && top.cents >= p.cents) continue;
      top = {
        cents: p.cents,
        text:
          p.to === g.my_member_id
            ? `${nameOf(p.from)} pays you ${formatCents(p.cents)}`
            : `You pay ${nameOf(p.to)} ${formatCents(p.cents)}`,
      };
    }
  }
  if (total === 0 && !top) return null;
  return (
    <Link to="/goals?tab=splits" className="card-link" aria-label="Split bills, open Splits">
      <Card as="section" aria-labelledby="home-owed">
        <h2 className="sk-card__title" id="home-owed">
          Split bills
        </h2>
        <Word>{total > 0 ? "Owed" : total < 0 ? "Owe" : "Clear"}</Word>
        <p className="sk-card__hero">
          {total > 0 ? "+" : ""}
          {formatCents(Math.abs(total))}
        </p>
        {top ? <p>{top.text}</p> : null}
      </Card>
    </Link>
  );
}
