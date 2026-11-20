import "./streaks.css";

import { compareText } from "@stackd/rules/text";
import { Button, Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { addDays, type WeeklyStreak } from "../../engine/bridge.ts";
import { formatDay, todayIso } from "../../lib/format.ts";
import {
  milestoneName,
  pathSummary,
  STREAK_LINES,
  STREAK_NAMES,
  stepName,
  weeksWord,
} from "./copy.ts";
import { DueStrip, StreakLegend, WeekStrip } from "./StreakParts.tsx";
import {
  setStreaksPaused,
  startAgain,
  takeRestWeek,
  type WeeklyStreakId,
} from "./streakSettings.ts";
import { type ProgressView, useProgress } from "./useProgress.ts";

/** The week just gone's Monday, from the strip (its second-to-last week). */
function lastWeekOf(s: WeeklyStreak): string | null {
  return s.weeks.at(-2)?.start ?? null;
}

/** A missed week the person hasn't answered yet, after a run worth keeping. */
export function freshStart(s: WeeklyStreak, id: WeeklyStreakId, seen: Record<string, string>) {
  const last = lastWeekOf(s);
  return (
    s.last_week === "missed" &&
    s.this_week !== "kept" &&
    s.held > 0 &&
    last !== null &&
    seen[id] !== last
  );
}

function StreakCard({
  id,
  streak,
  progress,
  extraLine,
}: {
  id: WeeklyStreakId;
  streak: WeeklyStreak;
  progress: ProgressView;
  extraLine?: string;
}) {
  const { db } = useDb();
  const last = lastWeekOf(streak);
  const fresh = freshStart(streak, id, progress.freshSeen);
  const headingId = `streak-${id}`;
  return (
    <Card as="section" aria-labelledby={headingId}>
      <div className="streak-card__head">
        <h2 className="sk-card__title" id={headingId}>
          {STREAK_NAMES[id]}
        </h2>
        <span className="streak-card__best">Best {weeksWord(streak.best)}</span>
      </div>
      {fresh ? (
        <>
          <Word>Fresh start</Word>
          <p className="sk-card__eyebrow">
            Last week didn't count. Your best stays {weeksWord(streak.best)}.
          </p>
        </>
      ) : (
        <>
          <Word>{streak.current > 0 ? weeksWord(streak.current) : "Start"}</Word>
          <p className="sk-card__eyebrow">
            {streak.this_week === "paused"
              ? "Paused this week"
              : `${STREAK_LINES[id]}${extraLine ? ` · ${extraLine}` : ""}`}
          </p>
        </>
      )}
      <WeekStrip weeks={streak.weeks} />
      {fresh && last ? (
        <div className="streak-card__actions">
          {streak.can_rest ? (
            <Button block onClick={() => void takeRestWeek(db, id, last)}>
              Use a rest week · keep your {streak.held}
            </Button>
          ) : (
            <p className="sk-card__eyebrow">
              No rest weeks left until {formatDay(streak.rests_renew)}.
            </p>
          )}
          <Button block variant="secondary" onClick={() => void startAgain(db, id, last)}>
            Start again this week
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Goals → Streaks (owner decision, November 19, 2026; the "Qash Streaks" canvas, A1): weekly
 * streaks of Set aside, On time, Under plan and Sorted, each shown once it has data, then Your
 * path and Milestones. A missed week is a Fresh start, never red; a rest week holds the run;
 * Pause streaks holds every one. Nothing here is ever sent anywhere.
 */
export function StreaksTab() {
  const { db } = useDb();
  const today = todayIso();
  const progress = useProgress(today);
  if (!progress.ready) {
    return <p className="sk-card__eyebrow">Counting your weeks…</p>;
  }
  const { setAside, underPlan, sorted, onTime, path, milestones } = progress;
  const weekly = [setAside, underPlan, sorted].filter((s): s is WeeklyStreak => s !== null);
  const going = weekly.filter((s) => s.current > 0).length + (onTime && onTime.current > 0 ? 1 : 0);
  const shownCount = weekly.length + (onTime ? 1 : 0);
  const current = path?.steps.find((s) => s.state === "current") ?? null;
  const summary = path
    ? pathSummary(path, current ? stepName(current.id, progress.layout) : null)
    : null;
  const newest = (milestones?.milestones ?? [])
    .filter((m) => m.reached_on)
    .sort((a, b) => compareText(a.reached_on ?? "", b.reached_on ?? ""))
    .at(-1);

  async function togglePause() {
    const yesterday = await addDays(today, -1);
    await setStreaksPaused(db, !progress.paused, today, yesterday);
  }

  return (
    <div className="streaks">
      <Card as="section" aria-label="Streaks summary">
        {progress.paused ? (
          <>
            <Word>Paused</Word>
            <p className="sk-card__eyebrow">Nothing counts, nothing breaks.</p>
          </>
        ) : shownCount === 0 ? (
          <>
            <Word>Start</Word>
            <p className="sk-card__eyebrow">Put money in a jar to start your first streak.</p>
          </>
        ) : (
          <>
            <Word>{going > 0 ? "Steady" : "Start"}</Word>
            <p className="sk-card__eyebrow">
              {going > 0
                ? `${going} ${going === 1 ? "streak" : "streaks"} going. Weeks run Monday to Sunday.`
                : "Nothing running this week. Your bests are kept."}
            </p>
          </>
        )}
        {shownCount > 0 ? <StreakLegend /> : null}
      </Card>

      {setAside ? <StreakCard id="set_aside" streak={setAside} progress={progress} /> : null}
      {onTime ? (
        <Card as="section" aria-labelledby="streak-on_time">
          <div className="streak-card__head">
            <h2 className="sk-card__title" id="streak-on_time">
              {STREAK_NAMES.on_time}
            </h2>
            <span className="streak-card__best">Best {onTime.best}</span>
          </div>
          <Word>
            {onTime.current > 0
              ? `${onTime.current} ${onTime.current === 1 ? "payment" : "payments"}`
              : "Start"}
          </Word>
          <p className="sk-card__eyebrow">card payments on time in a row</p>
          <DueStrip dues={onTime.shown} />
        </Card>
      ) : null}
      {underPlan ? <StreakCard id="under_plan" streak={underPlan} progress={progress} /> : null}
      {sorted ? (
        <StreakCard
          id="sorted"
          streak={sorted}
          progress={progress}
          extraLine={progress.toSort > 0 ? `${progress.toSort} to sort` : undefined}
        />
      ) : null}

      {path || milestones ? (
        <div className="streaks__pair">
          {path ? (
            <Link to="/path" className="card-link" aria-label="Your path, open Your path">
              <Card as="section" aria-labelledby="streaks-path">
                <h2 className="sk-card__title" id="streaks-path">
                  Your path
                </h2>
                <Word>{summary?.word ?? ""}</Word>
                <p className="sk-card__eyebrow">{summary?.line}</p>
              </Card>
            </Link>
          ) : null}
          {milestones ? (
            <Link to="/milestones" className="card-link" aria-label="Milestones, open Milestones">
              <Card as="section" aria-labelledby="streaks-milestones">
                <h2 className="sk-card__title" id="streaks-milestones">
                  Milestones
                </h2>
                <Word>{milestones.reached > 0 ? `${milestones.reached} reached` : "Start"}</Word>
                <p className="sk-card__eyebrow">
                  {newest?.reached_on
                    ? `Latest: ${milestoneName(newest.id)}, ${formatDay(newest.reached_on)}`
                    : "Your first one is close"}
                </p>
              </Card>
            </Link>
          ) : null}
        </div>
      ) : null}

      {shownCount > 0 || progress.paused ? (
        <div className="streaks__pause">
          <p className="sk-card__eyebrow">
            {progress.paused
              ? "Streaks are paused. Resume when you're ready; nothing was lost."
              : "Going away or between jobs? Pause every streak: nothing counts, nothing breaks."}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void togglePause()}>
            {progress.paused ? "Resume streaks" : "Pause streaks"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
