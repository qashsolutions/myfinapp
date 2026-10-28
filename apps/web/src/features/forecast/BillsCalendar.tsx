import { utcMs } from "@stackd/rules/dates";
import { useMemo, useState } from "react";
import type { UpcomingItem } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Calendar layout only (which column a date falls in); no money maths here. */
function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(utcMs(y, m - 1, d)).getUTCDay();
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split("-").map(Number) as [number, number, number];
  const at = new Date(utcMs(y, m - 1, d));
  for (let iso = start; iso <= end; ) {
    out.push(iso);
    at.setUTCDate(at.getUTCDate() + 1);
    iso = at.toISOString().slice(0, 10);
  }
  return out;
}

/**
 * Next 30 days as a calendar (owner sign-off October 19, 2026, item 8): a green dot for each
 * payday, a red one for each bill, a red tint where the estimated balance is under the cushion,
 * today outlined. Tapping a day shows what's due and the estimated balance that evening.
 */
export function BillsCalendar({
  start,
  end,
  today,
  items,
  balances,
  cushionCents,
  labelFor,
}: {
  start: string;
  end: string;
  today: string;
  items: UpcomingItem[];
  /** The forecast's balance per day; empty until a balance is set. */
  balances: Map<string, number>;
  cushionCents: number;
  labelFor: (item: UpcomingItem) => string;
}) {
  const days = useMemo(() => datesBetween(start, end), [start, end]);
  const byDay = useMemo(() => {
    const map = new Map<string, UpcomingItem[]>();
    for (const i of items) map.set(i.date, [...(map.get(i.date) ?? []), i]);
    return map;
  }, [items]);
  const firstBusy = days.find((d) => byDay.has(d)) ?? today;
  const [picked, setPicked] = useState<string>(byDay.has(today) ? today : firstBusy);

  // Cells are a date or a blank named by its place (before the first day or after the last).
  type Cell = { key: string; date: string | null };
  const lead = weekdayOf(days[0] ?? start);
  const cells: Cell[] = [
    ...WEEKDAYS.slice(0, lead).map((w) => ({ key: `before-${w}`, date: null })),
    ...days.map((d) => ({ key: d, date: d })),
  ];
  const tail = (7 - (cells.length % 7)) % 7;
  cells.push(...WEEKDAYS.slice(7 - tail).map((w) => ({ key: `after-${w}`, date: null })));
  const weeks: Cell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const describe = (d: string) => {
    const due = byDay.get(d) ?? [];
    const bits = due.map(
      (i) =>
        `${labelFor(i)} ${formatCents(i.amount_cents, i.kind === "income" ? "in" : "out")}${i.matched ? " (paid)" : ""}`,
    );
    const bal = balances.get(d);
    if (bal !== undefined) bits.push(`estimated balance ${formatCents(bal)}`);
    return `${formatDay(d)}${bits.length ? `: ${bits.join(", ")}` : ", nothing due"}`;
  };

  const pickedItems = byDay.get(picked) ?? [];
  const pickedBalance = balances.get(picked);
  return (
    <div className="cal">
      <table className="cal__grid">
        <caption className="sr-only">
          Bills and paydays from {formatDay(start)} to {formatDay(end)}
        </caption>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              <th key={w} scope="col" abbr={w}>
                {w[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((row) => (
            <tr key={row[0]?.key}>
              {row.map(({ key, date: d }) => {
                if (!d) return <td key={key} />;
                const due = byDay.get(d) ?? [];
                const bal = balances.get(d);
                const short = bal !== undefined && bal < cushionCents;
                const dayNum = Number(d.slice(8, 10));
                const showMonth = d === days[0] || dayNum === 1;
                return (
                  <td key={d}>
                    <button
                      type="button"
                      className={[
                        "cal__day",
                        d === today ? "cal__day--today" : "",
                        d === picked ? "cal__day--picked" : "",
                        short ? "cal__day--short" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-pressed={d === picked}
                      aria-label={describe(d)}
                      onClick={() => setPicked(d)}
                    >
                      <span className="cal__num" aria-hidden="true">
                        {showMonth ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${dayNum}` : dayNum}
                      </span>
                      <span className="cal__dots" aria-hidden="true">
                        {due.slice(0, 3).map((it) => (
                          <span
                            key={`${it.series_id}:${it.date}`}
                            className={`cal__dot cal__dot--${it.kind}${it.matched ? " cal__dot--paid" : ""}`}
                          />
                        ))}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cal__key" aria-hidden="true">
        <span className="cal__key-in">Payday</span>
        <span className="cal__key-bill">Bill</span>
        {balances.size ? <span className="cal__key-short">Under your cushion</span> : null}
      </div>
      <div className="cal__picked" aria-live="polite">
        <p className="cal__picked-day">
          {formatDay(picked)}
          {pickedBalance !== undefined ? (
            <span
              className={pickedBalance < cushionCents ? "cal__bal cal__bal--short" : "cal__bal"}
            >
              {" "}
              · about {formatCents(pickedBalance)} left that day
            </span>
          ) : null}
        </p>
        {pickedItems.length === 0 ? (
          <p className="auth__hint">Nothing due.</p>
        ) : (
          pickedItems.map((item) => (
            <div className="cal__row" key={`${item.series_id}:${item.date}`}>
              <span className="up-row__label">
                {labelFor(item)}
                {item.matched ? " · paid" : ""}
              </span>
              <span
                className={`up-row__amount${item.kind === "income" ? " up-row__amount--in" : ""}`}
              >
                {formatCents(item.amount_cents, item.kind === "income" ? "in" : "out")}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
