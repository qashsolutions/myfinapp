import "./streaks.css";

import { addDays, iso, parseDate } from "@stackd/rules/dates";
import { compareText } from "@stackd/rules/text";
import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { weeksWord } from "./copy.ts";
import { freshStart } from "./StreaksTab.tsx";
import { useSetAsideStreak } from "./useProgress.ts";

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * Home's Streaks card (owner decision, November 19, 2026; the canvas's A2): the Set aside streak
 * with this week's days, a $ on each day with new money in a jar. Hidden until there is a jar.
 * Opens Goals → Streaks. The day letters are layout only; the weeks come from the engine.
 */
export function StreakHomeCard({ today }: { today: string }) {
  const progress = useSetAsideStreak(today);
  const s = progress.streak;
  if (!progress.ready || !s) return null;
  const weekStart = s.weeks.at(-1)?.start ?? today;
  const first = parseDate(weekStart);
  const days = DAY_LETTERS.map((letter, i) => {
    const day = iso(addDays(first, i));
    return {
      letter,
      day,
      kept: progress.depositDays.includes(day),
      past: compareText(day, today) < 0,
    };
  });
  const fresh = freshStart(s, "set_aside", progress.freshSeen);
  let word: string;
  let line: string;
  if (progress.paused || s.this_week === "paused") {
    word = "Paused";
    line = "Streaks are paused. Nothing breaks.";
  } else if (fresh) {
    word = "Fresh start";
    line = `Last week didn't count. Your best stays ${weeksWord(s.best)}.`;
  } else {
    word = s.current > 0 ? weeksWord(s.current) : "Start";
    line =
      s.this_week === "kept"
        ? "Set aside this week. Done for this week."
        : "A deposit to any jar this week keeps it going.";
  }
  return (
    <Link to="/goals?tab=streaks" className="card-link" aria-label="Streaks, open Streaks">
      <Card as="section" aria-labelledby="home-streak">
        <h2 className="sk-card__title" id="home-streak">
          Streaks
        </h2>
        <Word>{word}</Word>
        <p className="sk-card__eyebrow">{line}</p>
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
      </Card>
    </Link>
  );
}
