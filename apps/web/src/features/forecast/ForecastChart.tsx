import type { UpcomingItem } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

const DESIGN_W = 354;
const H = 170;
const TOP = 22; // room for the "Today" label

type Day = { date: string; balance_cents: number };

/**
 * The day-by-day balance (mockup F3Forecast; markers October 25, 2026): the line, the cushion as
 * a dashed floor, today, a green "$" where pay lands and a red dot where a bill does, the lowest
 * point, and, when a what-if is set, its line dashed beside the real one.
 */
export function ForecastChart({
  days,
  bufferCents,
  lowestDate,
  lowestCents,
  items = [],
  whatIf = null,
}: {
  days: Day[];
  bufferCents: number;
  lowestDate: string;
  lowestCents: number;
  items?: UpcomingItem[];
  whatIf?: Day[] | null;
}) {
  const [box, W] = useBoxWidth(DESIGN_W);
  if (days.length < 2) return null;
  const values = [...days, ...(whatIf ?? [])].map((d) => d.balance_cents);
  const max = Math.max(...values, bufferCents, 0);
  const min = Math.min(...values, bufferCents, 0);
  const span = max - min || 1;
  const y = (v: number) => TOP + ((max - v) / span) * (H - TOP - 10);
  const x = (i: number) => (i / (days.length - 1)) * W;
  const line = (ds: Day[]) =>
    ds.map((d, i) => `${x(i).toFixed(1)},${y(d.balance_cents).toFixed(1)}`).join(" ");
  const index = new Map(days.map((d, i) => [d.date, i]));
  const lowIndex = index.get(lowestDate) ?? 0;
  const first = days[0] as Day;
  const mid = days[Math.floor((days.length - 1) / 2)] as Day;
  const last = days[days.length - 1] as Day;
  const floor = y(bufferCents);
  const dense = days.length > 120; // a year: smaller marks, no "$"
  const marks = items.filter((i) => !i.matched && index.has(i.date));
  const pays = marks.filter((i) => i.kind === "income").length;
  const bills = marks.length - pays;
  return (
    <>
      <div ref={box} className="chart-box">
        <svg
          className="forecast__chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Estimated balance over the next ${days.length - 1} days. Lowest ${formatCents(lowestCents)} on ${formatDay(lowestDate)}. ${pays} ${pays === 1 ? "payday" : "paydays"} and ${bills} ${bills === 1 ? "bill" : "bills"} marked.`}
        >
          <rect
            x="0"
            y={floor}
            width={W}
            height={Math.max(0, H - floor)}
            fill="var(--c-pending-bg)"
          />
          <line
            x1="0"
            y1={floor}
            x2={W}
            y2={floor}
            stroke="var(--c-sub)"
            strokeDasharray="4 4"
            strokeWidth="1"
          />
          <line x1="1" y1={TOP - 4} x2="1" y2={H} stroke="var(--c-sub)" strokeWidth="1" />
          <text x="4" y="12" className="forecast__today">
            Today
          </text>
          {whatIf ? (
            <polyline
              points={line(whatIf)}
              fill="none"
              stroke="var(--c-success)"
              strokeWidth="2.5"
              strokeDasharray="6 4"
              strokeLinejoin="round"
            />
          ) : null}
          <polyline
            points={line(days)}
            fill="none"
            stroke="var(--c-a1)"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {marks.map((item) => {
            const i = index.get(item.date) as number;
            const cy = y((days[i] as Day).balance_cents);
            if (item.kind === "bill")
              return (
                <circle
                  key={`${item.series_id}:${item.date}`}
                  cx={x(i)}
                  cy={cy}
                  r={dense ? 2.5 : 4.5}
                  fill="var(--c-danger)"
                />
              );
            return (
              <g key={`${item.series_id}:${item.date}`}>
                <circle cx={x(i)} cy={cy} r={dense ? 3.5 : 8} fill="var(--c-success)" />
                {dense ? null : (
                  <text x={x(i)} y={cy + 4} className="forecast__pay">
                    $
                  </text>
                )}
              </g>
            );
          })}
          <circle
            cx={x(lowIndex)}
            cy={y(lowestCents)}
            r="5"
            fill={lowestCents < bufferCents ? "var(--c-danger)" : "var(--c-a1)"}
            stroke="var(--c-card)"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="forecast__axis" aria-hidden="true">
        <span>{formatDay(first.date)}</span>
        <span>{formatDay(mid.date)}</span>
        <span>{formatDay(last.date)}</span>
      </div>
      <div className="forecast__legend" aria-hidden="true">
        <span>
          <i className="forecast__key forecast__key--pay" /> Pay
        </span>
        <span>
          <i className="forecast__key forecast__key--bill" /> Bill
        </span>
        <span>
          <i className="forecast__key forecast__key--floor" /> Cushion
        </span>
        {whatIf ? (
          <span>
            <i className="forecast__key forecast__key--whatif" /> What if
          </span>
        ) : null}
      </div>
    </>
  );
}
