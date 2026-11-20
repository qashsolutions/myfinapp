import "./streaks.css";

import { compareText } from "@stackd/rules/text";
import { Card } from "@stackd/ui";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { formatDay, todayIso } from "../../lib/format.ts";
import { milestoneMark, milestoneName, milestoneToGo } from "./copy.ts";
import { useProgress } from "./useProgress.ts";

/**
 * Milestones (owner decision, November 19, 2026; the canvas's C2): one-time, read from this
 * device's own entries and jars, kept with the day they were reached (`streaks.milestones`).
 * Unreached ones are dashed with how far there is to go.
 */
export function MilestonesScreen() {
  const progress = useProgress(todayIso());
  const result = progress.milestones;
  const reached = (result?.milestones ?? []).filter((m) => m.reached_on);
  const newest = [...reached]
    .sort((a, b) => compareText(a.reached_on ?? "", b.reached_on ?? ""))
    .at(-1);
  // Reached first (newest first), then the rest in their own order.
  const shown = [
    ...[...reached].sort((a, b) => compareText(b.reached_on ?? "", a.reached_on ?? "")),
    ...(result?.milestones ?? []).filter((m) => !m.reached_on),
  ];
  return (
    <>
      <ScreenHeader title="Milestones" back="/goals?tab=streaks" actions={null} />
      {!result ? (
        <p className="sk-card__eyebrow">Reading your milestones…</p>
      ) : (
        <>
          <Card as="section" aria-labelledby="milestones-summary">
            <h2 className="sk-card__title" id="milestones-summary">
              So far
            </h2>
            <Word>{result.reached > 0 ? `${result.reached} reached` : "Start"}</Word>
            <p className="sk-card__eyebrow">
              {newest?.reached_on
                ? `Newest: ${milestoneName(newest.id)}, ${formatDay(newest.reached_on)}.`
                : "Your first one is close."}
            </p>
          </Card>
          <ul className="badge-grid" aria-label="Milestones">
            {shown.map((m) => {
              const done = m.reached_on !== null;
              return (
                <li key={m.id} className={`badge${done ? "" : " badge--todo"}`}>
                  <span className="badge__mark" aria-hidden="true">
                    {milestoneMark(m.id)}
                  </span>
                  <p className="badge__name">
                    <span className="sr-only">{done ? "Reached: " : "Not yet: "}</span>
                    {milestoneName(m.id)}
                  </p>
                  <p className="badge__when">
                    {m.reached_on
                      ? formatDay(m.reached_on)
                      : (milestoneToGo(m.id, m.have, m.need) ?? "")}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="auth__fineprint">
            Read from your own entries and jars, on this device. Nothing here is sent anywhere.
          </p>
        </>
      )}
    </>
  );
}
