import { Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { type Projection, projectBalance, type UpcomingItem } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";

export interface WhatIfInput {
  asOf: string;
  days: number;
  startCents: number;
  dailyCents: number;
  items: UpcomingItem[];
  bufferCents: number;
  base: Projection;
}

/** Two dials that redraw the forecast: spend less each day, set some aside each payday. */
export interface WhatIfChoice {
  lessPerDayCents: number;
  savePerPaydayCents: number;
}

export const NO_CHANGE: WhatIfChoice = { lessPerDayCents: 0, savePerPaydayCents: 0 };

/**
 * The same `forecast.project` with the person's own what-if (October 25, 2026): typical daily
 * spending lowered by `lessPerDayCents` (never below zero), and a "set aside" outflow on every
 * payday in the span, as money moved to a jar would leave this account. No new rule: only its
 * inputs change, so the line is exactly as estimated as the real one.
 */
export async function projectWhatIf(input: WhatIfInput, choice: WhatIfChoice): Promise<Projection> {
  const paydays = input.items.filter((i) => i.kind === "income" && !i.matched);
  const saves: UpcomingItem[] =
    choice.savePerPaydayCents > 0
      ? paydays.map((p) => ({
          date: p.date,
          series_id: "whatif-save",
          payee: "Set aside",
          kind: "bill",
          amount_cents: choice.savePerPaydayCents,
          matched: false,
          entry_id: null,
        }))
      : [];
  return projectBalance(
    input.asOf,
    input.startCents,
    Math.max(0, input.dailyCents - choice.lessPerDayCents),
    [...input.items, ...saves],
    input.bufferCents,
    input.days,
  );
}

/** The what-if card: dials, then a one-word verdict and what it means. */
export function WhatIf({
  input,
  onLine,
}: {
  input: WhatIfInput;
  onLine: (days: Projection["days"] | null) => void;
}) {
  const [choice, setChoice] = useState<WhatIfChoice>(NO_CHANGE);
  const [result, setResult] = useState<Projection | null>(null);
  const changed = choice.lessPerDayCents > 0 || choice.savePerPaydayCents > 0;
  const paydays = input.items.filter((i) => i.kind === "income" && !i.matched);
  const biggestPay = Math.max(0, ...paydays.map((p) => p.amount_cents));
  // Dials move in whole dollars ($1 a day, $10 a payday) up to what could be spent or saved.
  const dailyMax = Math.floor(input.dailyCents / 100) * 100;
  const payMax = Math.floor(biggestPay / 1000) * 1000;

  useEffect(() => {
    let alive = true;
    if (!changed) {
      setResult(null);
      onLine(null);
      return;
    }
    void projectWhatIf(input, choice).then((p) => {
      if (!alive) return;
      setResult(p);
      onLine(p.days);
    });
    return () => {
      alive = false;
    };
  }, [input, choice, changed, onLine]);
  // Hidden or gone (Customize, no balance yet): take the dashed line with it (October 27, 2026).
  useEffect(() => () => onLine(null), [onLine]);

  if (dailyMax === 0 && payMax === 0) return null;
  const saved = choice.savePerPaydayCents * paydays.length;
  const gain = result ? result.lowest_cents - input.base.lowest_cents : 0;
  return (
    <Card as="section" aria-label="What if">
      <h2 className="sk-card__title">Try</h2>
      <p className="auth__hint">Move a dial and watch the dashed line.</p>
      {dailyMax > 0 ? (
        <label className="whatif__row">
          <span>
            Spend less each day{" "}
            <span className="whatif__value">{formatCents(choice.lessPerDayCents)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={dailyMax}
            step={100}
            value={choice.lessPerDayCents}
            aria-valuetext={`${formatCents(choice.lessPerDayCents)} a day`}
            onChange={(e) => setChoice({ ...choice, lessPerDayCents: Number(e.target.value) })}
          />
        </label>
      ) : null}
      {payMax > 0 ? (
        <label className="whatif__row">
          <span>
            Set aside each payday{" "}
            <span className="whatif__value">{formatCents(choice.savePerPaydayCents)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={payMax}
            step={1000}
            value={choice.savePerPaydayCents}
            aria-valuetext={`${formatCents(choice.savePerPaydayCents)} each payday`}
            onChange={(e) => setChoice({ ...choice, savePerPaydayCents: Number(e.target.value) })}
          />
        </label>
      ) : null}
      {result ? (
        <div role="status" className={result.shortfall ? "" : "forecast__status--ok"}>
          <p className="forecast__status-word">{result.shortfall ? "Short" : "Covered"}</p>
          <p>
            Lowest {formatCents(result.lowest_cents)} on {formatDay(result.lowest_date)}
            {gain !== 0 ? ` (${gain > 0 ? "up" : "down"} ${formatCents(Math.abs(gain))})` : ""}
            {saved > 0
              ? `, and ${formatCents(saved)} set aside by ${formatDay(result.days[result.days.length - 1]?.date ?? input.asOf)}`
              : ""}
            .
          </p>
          <button type="button" className="auth__link" onClick={() => setChoice(NO_CHANGE)}>
            Reset
          </button>
        </div>
      ) : null}
    </Card>
  );
}
