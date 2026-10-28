import "./goals.css";
import "../entries/entries.css";

import { Button, buttonClass, Card, Chip, Illustration, List } from "@stackd/ui";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Goal } from "../../data/db.ts";
import { todayIso } from "../../lib/format.ts";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/useMediaQuery.ts";
import { ChallengesTab } from "../groups/ChallengesTab.tsx";
import { GoalCard, GoalRow } from "./GoalCard.tsx";
import { useGoalCaps } from "./useGoalCaps.ts";
import { setPriorities, useGoals } from "./useGoals.ts";

/**
 * The Goals tab (mockup F4Goals): Jars (every goal kind) and Challenges. Jars are grouped so ten
 * stay tidy on a phone: the top one by priority as a full card, the rest in progress as one line
 * each, then Paused and Reached folded away. The plan's usage sits above ("Using 3 of 4");
 * every kept goal counts, finished ones too; moving one to templates frees its place.
 */
export function GoalsList() {
  const ids = useId();
  const goals = useGoals();
  const caps = useGoalCaps();
  const [tab, setTab] = useState<"jars" | "challenges">("jars");
  const desktop = useMediaQuery(DESKTOP_QUERY); // both panes side by side from 900px
  const [reordering, setReordering] = useState(false);
  const { db } = useDb();
  async function move(index: number, delta: number) {
    const ids = mine.map((g) => g.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const [id] = ids.splice(index, 1);
    ids.splice(target, 0, id as string);
    await setPriorities(db, ids);
  }
  const asOf = todayIso();
  const mine = (goals ?? []).filter((g) => g.group_id === null);
  const going = mine.filter((g) => g.status !== "reached" && !g.paused_at);
  const paused = mine.filter((g) => g.status !== "reached" && g.paused_at);
  const reached = mine.filter((g) => g.status === "reached");
  const usage =
    caps.max === null ? null : (
      <p className="jar-usage" role="status">
        <span>
          Using {caps.active} of {caps.max} on your plan
          {caps.challenges > 0
            ? ` (${caps.challenges} ${caps.challenges === 1 ? "is a challenge" : "are challenges"})`
            : ""}
        </span>
        {caps.full ? (
          <Link to="/me/plan" className="auth__link">
            See plans
          </Link>
        ) : (
          <Chip tone={caps.left === 1 ? "pending" : "neutral"}>{caps.left} left</Chip>
        )}
      </p>
    );
  const folded = (title: string, list: Goal[], note?: string) =>
    list.length === 0 ? null : (
      <details className="jar-group">
        <summary className="jar-group__summary">
          {title} · {list.length}
        </summary>
        {note ? <p className="sk-card__eyebrow">{note}</p> : null}
        <List card aria-label={title}>
          {list.map((g) => (
            <GoalRow key={g.id} goal={g} asOf={asOf} />
          ))}
        </List>
      </details>
    );
  const jars =
    mine.length === 0 && goals ? (
      <Card>
        <Illustration name="jar" tone="a2" />
        <p>
          No goals yet. Tap + New to save for something, pay something off, spend less, or build a
          habit.
        </p>
      </Card>
    ) : (
      <>
        {mine.length > 1 ? (
          <p className="sk-card__eyebrow">
            <button
              type="button"
              className="auth__link"
              aria-pressed={reordering}
              onClick={() => setReordering((v) => !v)}
            >
              {reordering ? "Done" : "Reorder"}
            </button>
            {reordering ? " · The top jar is the one Home nudges first." : ""}
          </p>
        ) : null}
        {usage}
        {reordering
          ? mine.map((g, i) => (
              <div className="reorder-row" key={g.id}>
                <span className="goal-card__title">
                  {i + 1}. {g.title}
                </span>
                <span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${g.title} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Move ${g.title} down`}
                    disabled={i === mine.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </Button>
                </span>
              </div>
            ))
          : null}
        {!reordering ? (
          <>
            {going[0] ? <GoalCard goal={going[0]} asOf={asOf} /> : null}
            {going.length > 1 ? (
              <List card aria-label="More jars in progress">
                {going.slice(1).map((g) => (
                  <GoalRow key={g.id} goal={g} asOf={asOf} />
                ))}
              </List>
            ) : null}
            {going.length === 0 && !caps.full ? (
              <p className="sk-card__eyebrow">Nothing in progress. Tap + New to start a jar.</p>
            ) : null}
            {folded("Paused", paused)}
            {folded(
              "Reached",
              reached,
              "Finished jars still count toward your plan. Open one and move it to your templates to free its place.",
            )}
          </>
        ) : null}
      </>
    );
  return (
    <>
      <ScreenHeader
        title="Goals"
        actions={
          <Link to="/goals/new" className={buttonClass({ size: "sm", variant: "secondary" })}>
            + New
          </Link>
        }
      />
      {desktop ? null : (
        <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
          <legend className="sr-only">Show</legend>
          {(
            [
              ["jars", `Jars · ${mine.length}`],
              ["challenges", "Challenges"],
            ] as const
          ).map(([value, label]) => (
            <label className="segmented__option" key={value}>
              <input
                className="segmented__input"
                type="radio"
                name={`${ids}-tab`}
                value={value}
                checked={tab === value}
                onChange={() => setTab(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      {desktop ? (
        <div className="two-pane">
          <section className="pane" aria-labelledby="jars-pane-h">
            <h2 className="section-title" id="jars-pane-h">
              Jars · {mine.length}
            </h2>
            {jars}
          </section>
          <section className="pane" aria-labelledby="challenges-pane-h">
            <h2 className="section-title" id="challenges-pane-h">
              Challenges
            </h2>
            <ChallengesTab />
          </section>
        </div>
      ) : null}
      {!desktop ? tab === "jars" ? jars : <ChallengesTab /> : null}
      <p className="auth__fineprint">
        Jars are virtual: logging a deposit records it here. Your money stays where it is.
      </p>
    </>
  );
}
