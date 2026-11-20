import type { DueResult, WeekState } from "../../engine/bridge.ts";
import { STATE_LABEL } from "./copy.ts";

/** The last weeks as a strip, oldest first (kept, rest week, not yet), with one label for it all. */
export function WeekStrip({ weeks }: { weeks: Array<{ start: string; state: WeekState }> }) {
  const shown = weeks.filter((w) => w.state !== "before");
  const count = (s: WeekState) => shown.filter((w) => w.state === s).length;
  const label = `Last ${shown.length} ${shown.length === 1 ? "week" : "weeks"}: ${count("kept")} kept${
    count("rest") ? `, ${count("rest")} rest` : ""
  }${count("missed") ? `, ${count("missed")} not kept` : ""}`;
  return (
    <p className="streak-strip" role="img" aria-label={label}>
      {weeks.map((w) => (
        <span
          key={w.start}
          className={`streak-strip__w streak-strip__w--${w.state}`}
          title={STATE_LABEL[w.state]}
        />
      ))}
      <span className="streak-strip__now" aria-hidden="true">
        now
      </span>
    </p>
  );
}

/** The latest card due dates as a strip: on time or missed. */
export function DueStrip({ dues }: { dues: Array<{ due_date: string; result: DueResult }> }) {
  const onTime = dues.filter((d) => d.result === "on_time").length;
  // Two cards can be due the same day: each mark gets its own key from its date and its turn.
  const seen = new Map<string, number>();
  const keyed = dues.map((d) => {
    const n = (seen.get(d.due_date) ?? 0) + 1;
    seen.set(d.due_date, n);
    return { key: `${d.due_date}:${n}`, result: d.result };
  });
  return (
    <p
      className="streak-strip"
      role="img"
      aria-label={`Last ${dues.length} due dates: ${onTime} on time`}
    >
      {keyed.map(({ key, result }) => (
        <span
          key={key}
          className={`streak-strip__w streak-strip__w--${result === "on_time" ? "on_time" : "missed"}`}
        />
      ))}
    </p>
  );
}

export function StreakLegend() {
  return (
    <ul className="streak-legend" aria-label="What the strips show">
      <li>
        <span className="streak-strip__w streak-strip__w--kept" aria-hidden="true" />
        Kept
      </li>
      <li>
        <span className="streak-strip__w streak-strip__w--rest" aria-hidden="true" />
        Rest week
      </li>
      <li>
        <span className="streak-strip__w streak-strip__w--open" aria-hidden="true" />
        Not yet
      </li>
    </ul>
  );
}
