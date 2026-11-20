import "./streaks.css";

import { compareText } from "@stackd/rules/text";
import { Card } from "@stackd/ui";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import type { Milestone } from "../../engine/bridge.ts";
import { formatDay, todayIso } from "../../lib/format.ts";
import { milestoneMark, milestoneName, milestoneToGo } from "./copy.ts";
import { useProgress } from "./useProgress.ts";

/**
 * Milestones (owner decision, November 19, 2026; the canvas's C2): one-time, read from this
 * device's own entries and jars, kept with the day they were reached (`streaks.milestones`).
 * Unreached ones are dashed with how far there is to go.
 */
function BadgeList({ title, items }: { title?: string; items: Milestone[] }) {
  return (
    <>
      {title ? <h2 className="section-title">{title}</h2> : null}
      <ul className="badge-grid" aria-label={title ?? "More milestones"}>
        {items.map((m) => {
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
    </>
  );
}

export function MilestonesScreen() {
  const progress = useProgress(todayIso());
  const result = progress.milestones;
  const reached = (result?.milestones ?? []).filter((m) => m.reached_on);
  const newest = [...reached]
    .sort((a, b) => compareText(a.reached_on ?? "", b.reached_on ?? ""))
    .at(-1);
  // Reached first (newest first); then the three closest to done; the rest folded away.
  const done = [...reached].sort((a, b) => compareText(b.reached_on ?? "", a.reached_on ?? ""));
  const share = (m: Milestone) =>
    m.have === null || m.need <= 0 ? -1 : Math.min(1, Math.max(0, m.have) / m.need);
  const open = (result?.milestones ?? []).filter((m) => !m.reached_on);
  const nextUp = [...open]
    .filter((m) => share(m) >= 0)
    .sort((a, b) => share(b) - share(a))
    .slice(0, 3);
  const later = open.filter((m) => !nextUp.includes(m));
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
                ? `Latest: ${milestoneName(newest.id)}, ${formatDay(newest.reached_on)}`
                : "Your first one is close."}
            </p>
          </Card>
          {done.length ? <BadgeList title={`Reached · ${done.length}`} items={done} /> : null}
          {nextUp.length ? <BadgeList title="Next up" items={nextUp} /> : null}
          {later.length ? (
            <details className="badge-more">
              <summary className="section-title">More milestones · {later.length}</summary>
              <BadgeList items={later} />
            </details>
          ) : null}
          <p className="auth__fineprint">
            Read from your own entries and jars, on this device. Nothing here is sent anywhere.
          </p>
        </>
      )}
    </>
  );
}
