import { Card } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { formatCents, formatDate } from "../../lib/format.ts";
import { fetchHistory, isFailure, type PlanEvent } from "./billing.ts";

const NAMES: Record<string, string> = {
  private: "Private",
  connected: "Connected",
  founding: "Founding",
};

function planName(e: PlanEvent): string {
  const name = NAMES[e.plan] ?? e.plan;
  return e.interval ? `${name} ${e.interval}` : name;
}

/** One row's headline and line (owner, October 18, 2026: short, the plan and the money). */
export function describe(e: PlanEvent): [string, string] {
  const amount = e.amount_cents;
  switch (e.kind) {
    case "trial_started":
      return ["Free trial started", NAMES[e.plan] ?? e.plan];
    case "subscribed":
      if (e.plan === "founding")
        return ["Founding member", amount !== null ? `${formatCents(amount)} once` : "4 years"];
      return [
        `Subscribed to ${planName(e)}`,
        amount !== null
          ? `${formatCents(amount)} a ${e.interval === "monthly" ? "month" : "year"}`
          : "",
      ];
    case "switched":
      return [
        `Switched to ${planName(e)}`,
        amount === null || amount === 0
          ? ""
          : amount > 0
            ? `${formatCents(amount)} charged`
            : `${formatCents(-amount)} became credit`,
      ];
    case "cancelled":
      return [
        "Cancelled",
        e.until ? `Runs until ${formatDate(e.until)}` : "Runs to the period's end",
      ];
    case "resumed":
      return ["Kept", `${planName(e)} renews as usual`];
    case "ended":
      return ["Plan ended", planName(e)];
  }
}

/** "Oct 18, 2026 · 10:51 AM" in the person's own time. */
function when(iso: string): string {
  const time = new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${formatDate(iso)} · ${time}`;
}

/** Plan history (owner decision, October 18, 2026): newest first, from the server's record.
 * `refreshKey` changes whenever the plan does, so a cancel or switch shows at once. */
export function PlanHistory({ refreshKey }: { refreshKey: unknown }) {
  const [events, setEvents] = useState<PlanEvent[] | null>(null);
  const headingId = useId();
  useEffect(() => {
    let live = true;
    void refreshKey;
    void fetchHistory().then((r) => {
      if (live) setEvents(isFailure(r) ? null : r);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);
  if (!events || events.length === 0) return null;
  // One group per year, newest first; the latest year is open, earlier years start folded.
  const years: Array<[string, PlanEvent[]]> = [];
  for (const e of events) {
    const y = String(new Date(e.at).getFullYear());
    const last = years.at(-1);
    if (last && last[0] === y) last[1].push(e);
    else years.push([y, [e]]);
  }
  const rows = (list: PlanEvent[]) => (
    <ol className="plan-history">
      {list.map((e) => {
        const [head, line] = describe(e);
        return (
          <li key={`${e.at}-${e.kind}`}>
            <div>
              <strong>{head}</strong>
              {line ? <span>{line}</span> : null}
            </div>
            <time dateTime={e.at}>{when(e.at)}</time>
          </li>
        );
      })}
    </ol>
  );
  return (
    <section aria-labelledby={headingId}>
      <h2 className="section-title" id={headingId}>
        Plan history
      </h2>
      <Card>
        {years.length === 1
          ? rows(events)
          : years.map(([year, list], n) => (
              <details key={year} className="plan-history__year" open={n === 0}>
                <summary>
                  {year} · {list.length} {list.length === 1 ? "change" : "changes"}
                </summary>
                {rows(list)}
              </details>
            ))}
      </Card>
    </section>
  );
}
