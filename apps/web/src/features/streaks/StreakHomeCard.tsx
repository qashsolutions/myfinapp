import "./streaks.css";

import { addDays, iso, parseDate } from "@stackd/rules/dates";
import { compareText } from "@stackd/rules/text";
import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { WeeklyStreak } from "../../engine/bridge.ts";
import { STREAK_NAMES, weeksWord } from "./copy.ts";
import { DueStrip, WeekStrip } from "./StreakParts.tsx";
import { freshStart } from "./StreaksTab.tsx";
import type { WeeklyStreakId } from "./streakSettings.ts";
import { type StreaksView, useStreaks } from "./useProgress.ts";

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const TILE_WEEKS = 6;

type StreakId = WeeklyStreakId | "on_time";

interface Shown {
  id: StreakId;
  word: string;
  current: number;
  weekly: WeeklyStreak | null;
}

function payments(n: number): string {
  return `${n} ${n === 1 ? "payment" : "payments"}`;
}

/** Every streak that has data, with its word: the count, Start, or Fresh start. */
function shownStreaks(v: StreaksView): Shown[] {
  const out: Shown[] = [];
  const weekly: Array<[WeeklyStreakId, WeeklyStreak | null]> = [
    ["set_aside", v.setAside],
    ["under_plan", v.underPlan],
    ["sorted", v.sorted],
  ];
  for (const [id, s] of weekly) {
    if (!s) continue;
    const word = freshStart(s, id, v.freshSeen)
      ? "Fresh start"
      : s.current > 0
        ? weeksWord(s.current)
        : "Start";
    out.push({ id, word, current: s.current, weekly: s });
  }
  if (v.onTime) {
    out.push({
      id: "on_time",
      word: v.onTime.current > 0 ? payments(v.onTime.current) : "Start",
      current: v.onTime.current,
      weekly: null,
    });
  }
  return out;
}

/**
 * The streak that leads: the longest weekly run going (Set aside first on a tie), else On time
 * when only that one runs, else Set aside (or the first there is). Weeks and payments are never
 * compared with each other.
 */
function leadOf(shown: Shown[]): Shown | null {
  const best = shown
    .filter((s) => s.weekly !== null)
    .reduce<Shown | null>(
      (top, s) => (s.current > 0 && (!top || s.current > top.current) ? s : top),
      null,
    );
  if (best) return best;
  const onTime = shown.find((s) => s.id === "on_time" && s.current > 0);
  return onTime ?? shown.find((s) => s.id === "set_aside") ?? shown[0] ?? null;
}

/**
 * Home's Streaks card (owner decision, November 19, 2026: the canvas's H1 + H4). The longest
 * streak going leads with its count, then this week's days for Set aside (a $ on each day with
 * new money in a jar) or its recent weeks; every other streak sits below as a small tile with
 * its count and last weeks. Hidden until any streak has data. Opens Goals → Streaks. A missed
 * week is Fresh start (plain), never red.
 */
export function StreakHomeCard({ today }: { today: string }) {
  const view = useStreaks(today);
  if (!view.ready) return null;
  const shown = shownStreaks(view);
  const lead = leadOf(shown);
  if (!lead) return null;
  const others = shown.filter((s) => s.id !== lead.id);

  let line: string;
  if (view.paused) line = "Streaks are paused. Nothing breaks.";
  else if (lead.word === "Fresh start")
    line = `${STREAK_NAMES[lead.id]}: last week didn't count. Your best stays ${weeksWord(lead.weekly?.best ?? 0)}.`;
  else if (lead.current > 0)
    line = `${STREAK_NAMES[lead.id]} · ${others.length ? "your longest going" : "keep it going"}`;
  else
    line =
      lead.id === "set_aside"
        ? "A deposit to any jar this week starts one."
        : "A good week starts any day.";

  const weekStart = view.setAside?.weeks.at(-1)?.start ?? today;
  const first = parseDate(weekStart);
  const days = DAY_LETTERS.map((letter, i) => {
    const day = iso(addDays(first, i));
    return {
      letter,
      day,
      kept: view.depositDays.includes(day),
      past: compareText(day, today) < 0,
    };
  });

  return (
    <Link to="/goals?tab=streaks" className="card-link" aria-label="Streaks, open Streaks">
      <Card as="section" aria-labelledby="home-streak">
        <h2 className="sk-card__title" id="home-streak">
          Streaks
        </h2>
        <Word>{view.paused ? "Paused" : lead.word}</Word>
        <p className="sk-card__eyebrow">{line}</p>
        {lead.id === "set_aside" ? (
          <ol className="streak-days" aria-label="This week">
            {days.map((d) => (
              <li key={d.day}>
                <span
                  className={`streak-days__dot${d.kept ? " streak-days__dot--kept" : d.past ? " streak-days__dot--past" : ""}`}
                  aria-hidden="true"
                >
                  {d.kept ? "$" : ""}
                </span>
                {d.kept ? <span className="sr-only">Set aside on </span> : null}
                {d.letter}
              </li>
            ))}
          </ol>
        ) : lead.weekly ? (
          <WeekStrip weeks={lead.weekly.weeks} />
        ) : view.onTime ? (
          <DueStrip dues={view.onTime.shown} />
        ) : null}
        {others.length ? (
          <ul className="streak-tiles" aria-label="Your other streaks">
            {others.map((s) => (
              <li className="streak-tile" key={s.id}>
                <span className="streak-tile__name">{STREAK_NAMES[s.id]}</span>
                <span className="streak-tile__count">{s.word}</span>
                {s.weekly ? (
                  <WeekStrip weeks={s.weekly.weeks.slice(-TILE_WEEKS)} compact />
                ) : view.onTime ? (
                  <DueStrip dues={view.onTime.shown.slice(-TILE_WEEKS)} compact />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </Link>
  );
}
