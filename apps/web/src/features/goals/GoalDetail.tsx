import "./goals.css";
import "../auth/auth.css";

import { Button, Card, Chip } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Goal } from "../../data/db.ts";
import { EngineError, parseAmount } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { emitMoment } from "../../moments/bus.ts";
import { useSession } from "../auth/useSession.tsx";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { EmergencySection } from "../emergency/EmergencySection.tsx";
import { isEmergencyJar } from "../home/useHome.ts";
import { useHouseholdCloseSync, useHouseholdStatus } from "../household/useHousehold.ts";
import { goalSentence } from "./GoalCard.tsx";
import { GoalExtras } from "./GoalExtras.tsx";
import { GrowCard, useGrowMonthly } from "./GrowCard.tsx";
import { challengeEnded, useGoalCaps } from "./useGoalCaps.ts";
import {
  addGoalEvent,
  moveMoney,
  saveTemplate,
  setPaused,
  stampMilestones,
  templatePayload,
  useGoalProgress,
  useGoals,
} from "./useGoals.ts";

/** A stand-in while the goal loads, so the hooks run in the same order every render. */
const NO_GOAL = { end_date: null } as unknown as Goal;

/** One goal (mockup F4Detail): progress, log a deposit / balance / check-in, recent events. */
export function GoalDetail() {
  const { id } = useParams();
  const { db } = useDb();
  const navigate = useNavigate();
  const today = todayIso();
  const goal = useLiveQuery<Goal | null>(
    async () => (id ? ((await db.goals.get(id)) ?? null) : null),
    [db, id],
  );
  const view = useGoalProgress(goal, today);
  const caps = useGoalCaps();
  const allGoals = useGoals();
  const { info } = useSession();
  const userId = info?.user?.id ?? "";
  const { status: householdStatus } = useHouseholdStatus();
  useHouseholdCloseSync(!!goal?.household_id); // a shared jar: pull every 15 s while open
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const growMonthly = useGrowMonthly(
    goal ?? NO_GOAL,
    goal?.grow && view?.progress ? view.progress.current : null,
    today,
  );

  if (goal === null) return <Navigate to="/goals" replace />;
  if (!goal || !view) {
    return (
      <>
        <ScreenHeader title="Goal" actions={null} back="/goals" />
        <p className="sr-only" role="status">
          Loading
        </p>
      </>
    );
  }
  const p = view.progress;
  const pct = p ? Math.round(p.display_bps / 100) : 0;
  // A challenge past its last day takes no more deposits or check-ins (invariant 56).
  const ended = challengeEnded(goal, today);
  const overCap = !ended && caps.readOnly.has(goal.id);
  const readOnly = overCap || ended;

  async function log(cents: number) {
    setError(null);
    if (!goal) return;
    const member = goal.household_id ? userId : null;
    if (goal.kind === "save") {
      const ev = await addGoalEvent(db, goal.id, "deposit", today, cents, new Date(), member);
      // Crossing the target is the big one; any other deposit is a ka-ching.
      const reached =
        p !== null && p.target > 0 && p.current < p.target && p.current + cents >= p.target;
      if (reached) emitMoment("goal_reached", { jar: goal.title }, ev.id);
      else if (cents > 0)
        emitMoment("jar_deposit", { jar: goal.title, amount: formatCents(cents) }, ev.id);
    } else if (goal.kind === "payoff") {
      const ev = await addGoalEvent(
        db,
        goal.id,
        "balance_update",
        today,
        cents,
        new Date(),
        member,
      );
      // p.remaining is the balance before this update.
      if (p && cents < p.remaining)
        emitMoment(
          "debt_paid_down",
          { jar: goal.title, amount: formatCents(p.remaining - cents) },
          ev.id,
        );
    }
    setCustom("");
  }

  async function logCustom() {
    try {
      const cents = await parseAmount(custom);
      if (cents < 0) throw new EngineError("invalid_amount");
      await log(cents);
    } catch {
      setError("Enter an amount like 76.00.");
    }
  }

  async function checkIn() {
    if (!goal) return;
    const already = view?.events.some((e) => e.type === "checkin" && e.date === today);
    if (already) return;
    await addGoalEvent(db, goal.id, "checkin", today, null);
    emitMoment("checkin_done", { jar: goal.title }, goal.id);
  }

  async function remove() {
    if (!goal) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await db.goals.update(goal.id, { status: "archived", updated_at: new Date().toISOString() });
    navigate("/goals", { replace: true });
  }

  const checkedToday = view.events.some((e) => e.type === "checkin" && e.date === today);
  // A grows jar's chip is GrowCard's month; its flat weekly pace (the future cost over the
  // weeks left) is never offered or shown.
  const first = goal.grow ? growMonthly : p?.weekly_pace;
  const quick = first && first > 0 ? [...new Set([first, 10000, 20000])] : [5000, 10000, 20000];

  return (
    <>
      <ScreenHeader title={goal.title} actions={null} back="/goals" />
      <Card tone="accent" as="section" aria-label="Progress">
        <div className="ring">
          <span className="ring__pct" role="img" aria-label={`${pct} percent`}>
            {pct}%
          </span>
          <div className="ring__text">
            <Word>
              {p?.status === "reached"
                ? "Reached"
                : goal.paused_at
                  ? "Paused"
                  : p?.status === "overdue"
                    ? "Behind"
                    : pct === 0
                      ? "Start"
                      : "Saving"}
            </Word>
            <span className="ring__big">
              {p
                ? goal.kind === "habit"
                  ? `${p.current} of ${p.target} days`
                  : formatCents(p.current)
                : ""}
            </span>
            <span>{goalSentence(goal)}</span>
            {goal.household_id ? <Chip tone="accent">Shared</Chip> : null}
            {goal.why_text ? <span className="goal-why">“{goal.why_text}”</span> : null}
          </div>
        </div>
      </Card>

      {isEmergencyJar(goal) && p ? <EmergencySection savedCents={p.current} /> : null}

      {goal.kind === "save" && goal.grow && p ? (
        <GrowCard goal={goal} savedCents={p.current} today={today} />
      ) : null}

      <GoalExtras
        goal={goal}
        events={view.events}
        savedCents={p?.current ?? 0}
        today={today}
        memberId={goal.household_id ? userId : null}
        onPause={(paused) => setPaused(db, goal, paused, today)}
        onMove={(toId, cents) =>
          moveMoney(db, goal.id, toId, cents, today, goal.household_id ? userId : null)
        }
        onStamp={async (results) => {
          const stamped = await stampMilestones(db, goal, results, today);
          for (const id of stamped) {
            const bps = Number(id.slice(id.lastIndexOf(":") + 1));
            emitMoment("milestone_reached", { jar: goal.title, percent: `${bps / 100}%` }, id);
          }
          return stamped;
        }}
        onSaveTemplate={(name, months) => saveTemplate(db, name, templatePayload(goal, months))}
        reached={goal.status === "reached" || p?.status === "reached"}
        onRemove={async () => {
          await db.goals.update(goal.id, {
            status: "archived",
            updated_at: new Date().toISOString(),
          });
          navigate("/goals", { replace: true });
        }}
        jars={(allGoals ?? []).filter(
          (g) => g.id !== goal.id && g.kind === "save" && g.status !== "archived",
        )}
      />

      {ended ? (
        <Card as="section" aria-label="Challenge ended">
          <Word>Ended</Word>
          <p>This challenge has ended. Everything here is kept, and it no longer uses a place.</p>
        </Card>
      ) : null}
      {overCap ? (
        <PlanLimit>
          Read-only: your plan has room for {caps.max} jars and goals, and this one came after them.
          Everything here is kept. Finish or remove another, or choose a bigger plan.
        </PlanLimit>
      ) : null}
      {!readOnly && (goal.kind === "save" || goal.kind === "payoff") ? (
        <Card
          as="section"
          aria-label={goal.kind === "save" ? "Log money you set aside" : "Update the balance"}
        >
          <h2 className="sk-card__title">
            {goal.kind === "save" ? "Log money you set aside" : "Update the balance"}
          </h2>
          {goal.kind === "save" ? (
            <div className="quick-amounts">
              {quick.map((c) => (
                <Button key={c} variant="secondary" onClick={() => log(c)}>
                  +{formatCents(c)}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="transfer-choice" style={{ gridTemplateColumns: "1fr auto" }}>
            <input
              className="auth__input"
              inputMode="decimal"
              placeholder={goal.kind === "save" ? "Other amount" : "Current balance"}
              aria-label={goal.kind === "save" ? "Other amount" : "Current balance"}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
            <Button onClick={logCustom}>{goal.kind === "save" ? "Log" : "Update"}</Button>
          </div>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="sk-card__eyebrow">This records it in Qash. Your money stays where it is.</p>
        </Card>
      ) : null}

      {goal.kind === "habit" && !readOnly ? (
        <Card as="section" aria-label="Check in">
          <Button block onClick={checkIn} disabled={checkedToday || p?.status === "reached"}>
            {checkedToday ? "Checked in today" : "Check in for today"}
          </Button>
          <p className="sk-card__eyebrow">
            One check-in per day.{" "}
            {p && p.days_left !== null && p.days_left >= 0
              ? `${p.days_left + 1} ${p.days_left === 0 ? "day" : "days"} left.`
              : ""}
          </p>
        </Card>
      ) : null}

      {goal.kind === "spend_less" ? (
        <Card as="section" aria-label="This month">
          <p>
            Usual spend {formatCents(goal.baseline_cents ?? 0)}.{" "}
            {p
              ? p.current >= 0
                ? `${formatCents(p.current)} saved so far.`
                : `${formatCents(-p.current)} over your usual so far.`
              : ""}
          </p>
          <p className="sk-card__eyebrow">
            Spending comes from your entries in {goal.title} this month.
          </p>
        </Card>
      ) : null}

      {p && !goal.grow ? (
        <Card as="section" aria-label="Pace">
          <p className="sk-card__eyebrow">
            {p.status === "reached"
              ? "Reached"
              : p.weekly_pace === null
                ? "No deadline"
                : goal.kind === "habit"
                  ? `${p.weekly_pace} ${p.weekly_pace === 1 ? "day" : "days"} a week to finish`
                  : `${formatCents(p.weekly_pace)} a week to finish${p.end_date ? ` by ${formatDay(p.end_date)}` : ""}`}
          </p>
          {goal.kind === "save" && p.status !== "reached" ? (
            <p className="sk-card__eyebrow">
              <Link to={`/what-if?goal=${encodeURIComponent(goal.id)}`}>
                What if I spent less and put it here?
              </Link>
            </p>
          ) : null}
        </Card>
      ) : null}

      {view.events.length > 0 && goal.kind !== "spend_less" ? (
        <Card as="section" aria-label="Recent">
          <h2 className="sk-card__title">
            {goal.kind === "save"
              ? "Recent deposits"
              : goal.kind === "payoff"
                ? "Balance updates"
                : "Check-ins"}
          </h2>
          {view.events.slice(0, 8).map((e) => (
            <div className="event-row" key={e.id}>
              <span>
                {formatDay(e.date)}
                {goal.household_id
                  ? ` · ${
                      !e.member_id || e.member_id === userId
                        ? "you"
                        : (householdStatus?.household?.members.find(
                            (m) => m.user_id === e.member_id,
                          )?.display_name ?? "partner")
                    }`
                  : ""}
              </span>
              <span className="event-row__amount">
                {e.type === "checkin"
                  ? "✓"
                  : e.type === "deposit"
                    ? `+${formatCents(e.amount_cents ?? 0)}`
                    : formatCents(e.amount_cents ?? 0)}
              </span>
            </div>
          ))}
        </Card>
      ) : null}

      <Button variant="ghost" block onClick={remove}>
        <span style={{ color: "var(--c-danger)" }}>
          {confirmDelete ? "Really remove this goal" : "Remove goal"}
        </span>
      </Button>
    </>
  );
}
