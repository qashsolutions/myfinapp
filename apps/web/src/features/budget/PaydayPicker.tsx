import { addDays, iso, parseDate, weekday } from "@stackd/rules/dates";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { PayFrequency } from "../../data/db.ts";
import { nextPaydays } from "../../engine/bridge.ts";
import { addDaysIso } from "../../lib/dates.ts";
import { formatDay } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { useRecurringSuggestions } from "../forecast/useRecurring.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { dayName, LAST_DAY, MONTHLY_DAYS, scheduleFor, TWICE_A_MONTH } from "./payDays.ts";

export interface PaydayValue {
  nextPayday: string;
  days: number[] | null;
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Fri, Nov 6" for a suggested date. */
function withWeekday(date: string): string {
  return `${WEEKDAY[weekday(parseDate(date))]}, ${formatDay(date)}`;
}

/** The next Friday on or after today: the usual payday when nothing better is known. */
export function nextFriday(today: string): string {
  const d = parseDate(today);
  return iso(addDays(d, (4 - weekday(d) + 7) % 7));
}

/**
 * The paycheck the person's statements show, for a weekly kind: its next date when Qash found a
 * paycheck repeating at that frequency (confirmed first, then a suggestion), else null.
 */
function useStatementPayday(frequency: PayFrequency, today: string): string | null {
  const { db } = useDb();
  const suggestions = useRecurringSuggestions(today);
  const confirmed = useLiveQuery(
    () =>
      db.recurring_series
        .where("status")
        .equals("confirmed")
        .filter((s) => s.kind === "income")
        .toArray(),
    [db],
  );
  if (frequency !== "weekly" && frequency !== "biweekly") return null;
  const found = [
    ...(confirmed ?? []).map((s) => ({ ...s, rank: 0 })),
    ...(suggestions ?? []).filter((s) => s.kind === "income").map((s) => ({ ...s, rank: 1 })),
  ]
    .filter((s) => s.interval === frequency && compareText(s.next_date, today) >= 0)
    .sort((a, b) => a.rank - b.rank || b.expected_cents - a.expected_cents);
  return found[0]?.next_date ?? null;
}

/**
 * When you're paid (October 28, 2026; suggest, then take their own). Weekly kinds: a suggested
 * next payday (from your statements, else the next Friday) or any date. Twice a month: the two
 * days, 1st & 15th or 15th & last day in one tap, or any two. Monthly: the day. The next three
 * paydays show underneath, from the engine, so a wrong pick is seen before Continue.
 */
export function PaydayPicker({
  frequency,
  value,
  onChange,
  onDefault,
  today,
}: {
  frequency: PayFrequency;
  value: PaydayValue;
  /** The person picked. */
  onChange: (next: PaydayValue) => void;
  /** A suggested default filled an empty choice (never over saved pay). */
  onDefault: (next: PaydayValue) => void;
  today: string;
}) {
  const ids = useId();
  const fromStatements = useStatementPayday(frequency, today);
  const friday = nextFriday(today);
  const [preview, setPreview] = useState<string[]>([]);
  const schedule = useMemo(
    () => scheduleFor(frequency, value.nextPayday || null, value.days),
    [frequency, value.nextPayday, value.days],
  );
  useEffect(() => {
    let alive = true;
    if (!schedule) {
      setPreview([]);
      return;
    }
    void nextPaydays(addDaysIso(today, -1), schedule, 3).then((d) => alive && setPreview(d));
    return () => {
      alive = false;
    };
  }, [schedule, today]);

  // A suggested default the person sees picked, until they choose (owner, October 28, 2026).
  // The statements answer after the first paint, so a Friday filled in meanwhile is replaced by
  // the paycheck they show; a date the person picked never is.
  const suggested = useRef<string | null>(null);
  useEffect(() => {
    if (frequency === "weekly" || frequency === "biweekly") {
      const best = fromStatements ?? friday;
      const ours = !value.nextPayday || value.nextPayday === suggested.current;
      if (ours && value.nextPayday !== best) {
        suggested.current = best;
        onDefault({ nextPayday: best, days: null });
      }
    } else if (!value.days?.length) {
      onDefault({
        nextPayday: "",
        days: frequency === "monthly" ? [1] : [...(TWICE_A_MONTH[0] as [number, number])],
      });
    }
  }, [frequency, value.nextPayday, value.days, fromStatements, friday, onDefault]);

  const dayOptions = Array.from({ length: LAST_DAY }, (_, i) => i + 1);

  return (
    <div className="payday">
      {frequency === "weekly" || frequency === "biweekly" ? (
        <ChipsOrOwn
          name={`${ids}-next`}
          legend="Next payday"
          options={[
            ...(fromStatements
              ? [
                  [fromStatements, `${withWeekday(fromStatements)} · from your statements`] as [
                    string,
                    string,
                  ],
                ]
              : []),
            ...(fromStatements === friday
              ? []
              : [[friday, withWeekday(friday)] as [string, string]]),
          ]}
          value={value.nextPayday}
          onPick={(v) => onChange({ nextPayday: v, days: null })}
          own={{
            label: "Next payday, your own date",
            type: "date",
            min: today,
            parse: (t) =>
              /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(t) && compareText(t, today) >= 0
                ? { value: t }
                : { error: "Pick today or a later date." },
          }}
        />
      ) : frequency === "semimonthly" ? (
        <TwoDays
          ids={ids}
          days={value.days}
          onDays={(days) => onChange({ nextPayday: "", days })}
          options={dayOptions}
        />
      ) : (
        <ChipsOrOwn
          name={`${ids}-day`}
          legend="Paid on the"
          options={MONTHLY_DAYS.map((d) => [String(d), dayName(d)])}
          value={String(value.days?.[0] ?? "")}
          display={(v) => dayName(Number(v))}
          onPick={(v) => onChange({ nextPayday: "", days: [Number(v)] })}
          own={{
            label: "Your own payday, 1 to 31",
            placeholder: "Or your own day, 1 to 31",
            parse: (t) => {
              const n = Number(t.replace(/[^0-9]/g, ""));
              return Number.isInteger(n) && n >= 1 && n <= LAST_DAY
                ? { value: String(n) }
                : { error: "Pick a day from 1 to 31." };
            },
          }}
        />
      )}
      {preview.length ? (
        <p className="payday__next" role="status">
          Next paydays <strong>{preview.map((d) => formatDay(d)).join(" · ")}</strong>
        </p>
      ) : null}
    </div>
  );
}

/** Twice a month: a suggested pair in one tap, or any two days. */
function TwoDays({
  ids,
  days,
  onDays,
  options,
}: {
  ids: string;
  days: number[] | null;
  onDays: (days: number[]) => void;
  options: number[];
}) {
  const key = (d: number[] | null) => (d ?? []).join(",");
  const known = TWICE_A_MONTH.some((p) => key(p) === key(days));
  const [own, setOwn] = useState(!known && (days?.length ?? 0) === 2);
  const [first, second] = [days?.[0] ?? 7, days?.[1] ?? 22];
  return (
    <fieldset className="payday__pick">
      <legend className="auth__label">Paid on</legend>
      <div className="chips">
        {TWICE_A_MONTH.map((pair) => (
          <label className="chip-option" key={key(pair)}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-pair`}
              checked={!own && key(pair) === key(days)}
              onChange={() => {
                setOwn(false);
                onDays([...pair]);
              }}
            />
            {pair.map(dayName).join(" & ")}
          </label>
        ))}
        <label className="chip-option">
          <input
            className="segmented__input"
            type="radio"
            name={`${ids}-pair`}
            checked={own}
            onChange={() => {
              setOwn(true);
              onDays([first, second].sort((a, b) => a - b));
            }}
          />
          Other days
        </label>
      </div>
      {own ? (
        <div className="payday__days">
          {(["First payday", "Second payday"] as const).map((label, i) => (
            <label className="payday__day" key={label}>
              <span className="auth__label">{label}</span>
              <select
                className="auth__input"
                value={i === 0 ? first : second}
                onChange={(e) => {
                  const picked = Number(e.target.value);
                  const next = i === 0 ? [picked, second] : [first, picked];
                  onDays([...new Set(next)].sort((a, b) => a - b));
                }}
              >
                {options.map((d) => (
                  <option key={d} value={d}>
                    {dayName(d)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}
