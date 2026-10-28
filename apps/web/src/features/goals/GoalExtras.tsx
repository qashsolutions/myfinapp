import "../auth/auth.css";

import { Button, Card, ProgressBar, Sheet, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { Goal, GoalEvent, PaySettings } from "../../data/db.ts";
import {
  type GoalPlan,
  type GoalStreak,
  goalMilestones,
  goalPlan,
  goalStreak,
  type MilestoneResult,
  parseAmount,
} from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { checkpointsText, parseCheckpoints } from "../../lib/ownValues.ts";
import { payScheduleOf } from "../home/useHome.ts";
import { ChipsOrOwn } from "./CustomValueSheet.tsx";
import { CADENCE_WORDS } from "./GoalCard.tsx";
import { MILESTONE_SETS } from "./presets.ts";
import { changeMilestones } from "./useGoals.ts";

const CADENCE_NOUN: Record<string, [string, string]> = {
  weekly: ["week", "weeks"],
  biweekly: ["2 weeks", "periods"],
  monthly: ["month", "months"],
  payday: ["paycheck", "paychecks"],
};

/**
 * The jar's extras (fast-follow 3; mockup F4Detail): the plan line for a cadence, the streak
 * for an ongoing jar, milestones at the chosen checkpoints, pause / resume, moving money to
 * another jar, and saving the jar as a template. Every number comes from the engine.
 */
export function GoalExtras({
  goal,
  events,
  savedCents,
  today,
  jars,
  onPause,
  onMove,
  onStamp,
  onSaveTemplate,
  onRemove,
  reached,
}: {
  goal: Goal;
  events: GoalEvent[];
  savedCents: number;
  today: string;
  jars: Goal[];
  onPause: (paused: boolean) => Promise<void>;
  onMove: (toId: string, cents: number) => Promise<void>;
  onStamp: (results: MilestoneResult[]) => Promise<string[]>;
  onSaveTemplate: (name: string, months: number | null) => Promise<unknown>;
  /** Removes the jar after saving it as a template, freeing its place on the plan. */
  onRemove: () => Promise<unknown>;
  /** The jar has reached its target: removing it after saving is the default. */
  reached: boolean;
  memberId?: string | null;
}) {
  const { db } = useDb();
  const ids = useId();
  const pay = useLiveQuery(
    async () => ((await db.settings.get("pay"))?.value as PaySettings | undefined) ?? null,
    [db],
  );
  const [plan, setPlan] = useState<GoalPlan | null>(null);
  const [streak, setStreak] = useState<GoalStreak | null>(null);
  const [milestones, setMilestones] = useState<MilestoneResult[] | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [milestonesOpen, setMilestonesOpen] = useState(false);
  const canMilestone = goal.kind === "save" && !goal.is_ongoing && !!goal.target_cents;
  const [moveTo, setMoveTo] = useState<string>("");
  const [moveText, setMoveText] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState(goal.title);
  const [removeAfter, setRemoveAfter] = useState(reached);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schedule = useMemo(() => payScheduleOf(pay ?? undefined), [pay]);
  const ruleEvents = useMemo(
    () =>
      events
        .filter((e) => e.type !== "checkin")
        .map((e) => ({ type: e.type, date: e.date, amount_cents: e.amount_cents })),
    [events],
  );
  const stamp = useRef(onStamp);
  stamp.current = onStamp;

  useEffect(() => {
    if (goal.kind !== "save" || !goal.cadence || pay === undefined) return;
    if (goal.cadence === "payday" && !schedule) return;
    let alive = true;
    void (async () => {
      if (goal.is_ongoing && goal.per_period_cents) {
        const s = await goalStreak(
          {
            kind: "save",
            start_date: goal.start_date,
            cadence: goal.cadence as string,
            per_period_cents: goal.per_period_cents,
            pauses: goal.pauses ?? [],
          },
          ruleEvents,
          today,
          schedule,
        );
        if (alive) setStreak(s);
        return;
      }
      if (!goal.target_cents) return;
      const p = await goalPlan(
        {
          kind: "save",
          target_cents: goal.target_cents,
          start_date: goal.start_date,
          end_date: goal.end_date,
          cadence: goal.cadence as string,
          per_period_cents: goal.per_period_cents ?? null,
        },
        ruleEvents,
        today,
        schedule,
      );
      if (alive) setPlan(p);
    })().catch(() => null);
    return () => {
      alive = false;
    };
  }, [goal, ruleEvents, today, pay, schedule]);

  useEffect(() => {
    const bps = goal.milestones_bps ?? [];
    if (goal.kind !== "save" || goal.is_ongoing || !goal.target_cents || bps.length === 0) {
      setMilestones(null);
      return;
    }
    let alive = true;
    void (async () => {
      const list = await goalMilestones(goal.target_cents as number, savedCents, bps);
      if (!alive) return;
      setMilestones(list);
      await stamp.current(list);
    })().catch(() => null);
    return () => {
      alive = false;
    };
  }, [goal.kind, goal.is_ongoing, goal.target_cents, goal.milestones_bps, savedCents]);

  async function move() {
    setError(null);
    try {
      const cents = await parseAmount(moveText);
      if (cents <= 0 || !moveTo) throw new Error("invalid");
      if (cents > savedCents) {
        setError(`This jar holds ${formatCents(savedCents)}.`);
        return;
      }
      await onMove(moveTo, cents);
      setMoveOpen(false);
      setMoveText("");
      setNote(
        `Moved ${formatCents(cents)} to ${jars.find((j) => j.id === moveTo)?.title ?? "the other jar"}.`,
      );
    } catch {
      setError("Enter an amount like 50 and pick a jar.");
    }
  }

  async function save() {
    const name = templateName.trim();
    if (!name) {
      setError("Give the template a name.");
      return;
    }
    let months: number | null = null;
    if (goal.end_date) {
      const start = new Date(`${goal.start_date}T00:00:00Z`);
      const end = new Date(`${goal.end_date}T00:00:00Z`);
      months = Math.max(
        1,
        (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          end.getUTCMonth() -
          start.getUTCMonth(),
      );
    }
    await onSaveTemplate(name, months);
    setTemplateOpen(false);
    if (removeAfter) {
      await onRemove();
      return;
    }
    setNote(`Saved "${name}" to My templates. Find it under + New on Goals.`);
  }

  if (goal.kind !== "save") return null;
  const nouns = CADENCE_NOUN[goal.cadence ?? ""] ?? ["period", "periods"];

  return (
    <>
      {plan && goal.cadence ? (
        <Card as="section" aria-label="Plan">
          <p className="sk-card__eyebrow">
            {plan.needs_amount
              ? "Set an amount each time to see the finish date."
              : plan.remaining_cents === 0
                ? "Reached. Nothing more to set aside."
                : `${formatCents(plan.per_period_cents ?? 0)} ${goal.cadence === "biweekly" ? "every 2 weeks" : `a ${nouns[0]}`} · ${plan.periods_left} ${plan.periods_left === 1 ? nouns[0] : nouns[1]} to ${formatCents(goal.target_cents ?? 0)}${plan.finish_date ? ` by ${formatDay(plan.finish_date)}` : ""} · next deposit ${formatDay(plan.next_date)}`}
          </p>
        </Card>
      ) : null}
      {streak && goal.is_ongoing ? (
        <Card as="section" aria-label="Streak">
          <p className="sk-card__hero">
            {streak.streak} {streak.streak === 1 ? nouns[0] : nouns[1]} in a row
          </p>
          <p className="sk-card__eyebrow">
            {formatCents(goal.per_period_cents ?? 0)} {CADENCE_WORDS[goal.cadence ?? "monthly"]} ·{" "}
            {formatCents(streak.total_cents)} saved in all · this {nouns[0]}:{" "}
            {formatCents(streak.current.saved_cents)}
            {streak.current.met ? " ✓" : ""}
            {streak.current.paused ? " (paused)" : ""}
          </p>
        </Card>
      ) : null}
      {milestones ? (
        <Card as="section" aria-label="Milestones">
          <h2 className="sk-card__title">Milestones</h2>
          {milestones.map((m) => (
            <div className="milestone-row" key={m.bps}>
              <span>
                {m.reached ? "✓ " : ""}
                {m.bps / 100}% · {formatCents(m.target_cents)}
              </span>
              <span className="sk-card__eyebrow">
                {m.reached
                  ? "Reached"
                  : `${formatCents(Math.max(0, m.target_cents - savedCents))} to go`}
              </span>
            </div>
          ))}
          <ProgressBar
            fraction={Math.min(1, goal.target_cents ? savedCents / goal.target_cents : 0)}
            label="Progress to the target"
            valueText={`${formatCents(savedCents)} of ${formatCents(goal.target_cents ?? 0)}`}
          />
          <Button size="sm" variant="ghost" onClick={() => setMilestonesOpen(true)}>
            Change milestones
          </Button>
        </Card>
      ) : canMilestone ? (
        <Button variant="ghost" block onClick={() => setMilestonesOpen(true)}>
          Add milestones
        </Button>
      ) : null}
      <div className="transfer-choice">
        <Button variant="secondary" onClick={() => onPause(!goal.paused_at)}>
          {goal.paused_at ? "Resume jar" : "Pause jar"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setMoveOpen(true)}
          disabled={jars.length === 0 || savedCents <= 0}
        >
          Move money
        </Button>
      </div>
      <Button
        variant={reached ? "secondary" : "ghost"}
        block
        onClick={() => {
          setRemoveAfter(reached);
          setTemplateOpen(true);
        }}
      >
        {reached ? "Move to my templates" : "Save as my template"}
      </Button>
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}

      <Sheet
        open={milestonesOpen}
        onClose={() => setMilestonesOpen(false)}
        title="Cheer at which milestones?"
      >
        <ChipsOrOwn
          name={`${ids}-milestones`}
          legend="Milestones"
          options={MILESTONE_SETS.map((set) => [set.join(","), checkpointsText(set)])}
          value={(goal.milestones_bps ?? []).join(",")}
          display={(v) => checkpointsText(v.split(",").map(Number))}
          onPick={async (v) => {
            await changeMilestones(db, goal, v.split(",").map(Number), savedCents, today);
            setMilestonesOpen(false);
          }}
          own={{
            label: "Your own milestones, in percent",
            placeholder: "Or your own, like 10, 50, 90",
            inputMode: "text",
            parse: (t) => {
              const bps = parseCheckpoints(t);
              return bps
                ? { value: bps.join(",") }
                : { error: "Up to five whole percents from 1 to 99, like 10, 50, 90." };
            },
          }}
        />
        {(goal.milestones_bps ?? []).length > 0 ? (
          <Button
            variant="ghost"
            block
            onClick={async () => {
              await changeMilestones(db, goal, [], savedCents, today);
              setMilestonesOpen(false);
            }}
          >
            No milestones
          </Button>
        ) : null}
      </Sheet>

      <Sheet open={moveOpen} onClose={() => setMoveOpen(false)} title="Move money to another jar">
        <p className="auth__hint">
          Moves part of what this jar holds into another jar. Nothing leaves your account; it's a
          relabel.
        </p>
        <label className="auth__field">
          <span className="auth__label">To</span>
          <select
            className="auth__input"
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            id={`${ids}-to`}
          >
            <option value="">Pick a jar</option>
            {jars.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </label>
        <label className="auth__field">
          <span className="auth__label">Amount</span>
          <input
            className="auth__input"
            inputMode="decimal"
            value={moveText}
            onChange={(e) => setMoveText(e.target.value)}
            placeholder="50"
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={move}>
          Move
        </Button>
      </Sheet>
      <Sheet open={templateOpen} onClose={() => setTemplateOpen(false)} title="Save as my template">
        <p className="auth__hint">
          Keeps this jar's name, amount, timing and milestones for next time. Sharing a template
          with a group comes with more challenge types.
        </p>
        <label className="auth__field">
          <span className="auth__label">Template name</span>
          <input
            className="auth__input"
            value={templateName}
            maxLength={40}
            onChange={(e) => setTemplateName(e.target.value)}
          />
        </label>
        <Toggle
          checked={removeAfter}
          onChange={setRemoveAfter}
          label="Remove this jar after saving"
          description="Frees its place on your plan. Start it again any time from + New."
        />
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={save}>
          {removeAfter ? "Save and remove jar" : "Save template"}
        </Button>
      </Sheet>
    </>
  );
}
