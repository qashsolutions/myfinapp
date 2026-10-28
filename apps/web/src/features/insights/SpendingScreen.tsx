import "./insights.css";
import "../ranges/ranges.css";

import { Card, List, ListRow } from "@stackd/ui";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useLookups } from "../entries/useEntries.ts";
import { RangePicker, RangeStepper } from "../ranges/RangePicker.tsx";
import { RANGE_NAME, useRange } from "../ranges/ranges.ts";
import { useTopSpending } from "./useTopSpending.ts";

/**
 * Biggest & most often (owner sign-off October 19, 2026, item 6): the largest single amounts out
 * and the merchants paid most often over a time range, from `insights.top_spending`. Money out
 * only; transfers and refunds are left out. Each purchase opens its entry; each merchant
 * unfolds to its entries in the range.
 */
export function SpendingScreen() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const { range, setRange, back, setBack } = useRange("spending", "Quarter");
  const view = useTopSpending(range, todayIso(), 10, back);
  const top = view.result;
  const categoryOf = (id: string) => {
    const e = view.entries.get(id);
    return e?.category_id ? lookups?.categories.get(e.category_id)?.name : null;
  };
  const open = (id: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(`/entries/${id}`);
  };

  return (
    <>
      <ScreenHeader title="Biggest & most often" back="/insights" actions={null} />
      <RangePicker value={range} onChange={setRange} />
      <RangeStepper bounds={view.bounds} onBack={setBack} />
      {!top ? (
        <p className="range-note">Adding it up…</p>
      ) : top.count === 0 ? (
        <Card>
          <p>Nothing out in {back === 0 ? RANGE_NAME[range] : view.bounds?.label} yet.</p>
        </Card>
      ) : (
        <>
          <section aria-labelledby="top-big">
            <h2 className="range-h" id="top-big">
              Biggest single amounts
            </h2>
            <List card>
              {top.largest.map((r) => (
                <ListRow
                  key={r.id}
                  label={r.payee?.trim() || "No name"}
                  sublabel={[formatDay(r.date), categoryOf(r.id)].filter(Boolean).join(" · ")}
                  value={formatCents(r.amount_cents, "out")}
                  href={`/entries/${r.id}`}
                  onClick={open(r.id)}
                />
              ))}
            </List>
          </section>
          <section aria-labelledby="top-often">
            <h2 className="range-h" id="top-often">
              Paid most often
            </h2>
            <Card>
              {top.merchants.map((m) => {
                const theirs = [...view.entries.values()]
                  .filter((e) => view.keys.get(e.id) === m.key)
                  .sort((a, b) => compareText(b.date, a.date));
                return (
                  <details className="often" key={m.key}>
                    <summary className="often__row">
                      <span className="often__name">{m.name}</span>
                      <span className="often__count">
                        {m.count} {m.count === 1 ? "time" : "times"} · last {formatDay(m.last_date)}
                      </span>
                      <span className="often__total">{formatCents(m.total_cents)}</span>
                    </summary>
                    <ul className="often__list">
                      {theirs.map((e) => (
                        <li key={e.id}>
                          <a href={`/entries/${e.id}`} onClick={open(e.id)}>
                            <span>{formatDay(e.date)}</span>
                            <span>{formatCents(e.amount_cents, "out")}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </Card>
          </section>
          <p className="auth__fineprint">
            Money out only. Refunds and the transfers you've marked are left out; mark a card
            payment as a transfer and it leaves this list.
          </p>
        </>
      )}
    </>
  );
}
