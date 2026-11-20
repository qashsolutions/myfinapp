import "./streaks.css";

import { Button, buttonClass, Card, ProgressBar, Sheet } from "@stackd/ui";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { PathStep, PathStepId } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { STEP_NAMES, stepName } from "./copy.ts";
import { NAME_MAX, type PathLayout, savePathLayout } from "./streakSettings.ts";
import { useProgress } from "./useProgress.ts";

/** Where each step's facts live, so the current step can be acted on. */
const STEP_LINKS: Record<PathStepId, { to: string; label: string }> = {
  setup: { to: "/setup", label: "Finish setting up" },
  cushion: { to: "/forecast", label: "See Next 30 days" },
  starter: { to: "/emergency", label: "Open Emergency fund" },
  paid_in_full: { to: "/credit-habits", label: "See Credit habits" },
  debts: { to: "/bills?tab=debt", label: "See Debt payoff" },
  three_months: { to: "/emergency", label: "Open Emergency fund" },
  later: { to: "/net-worth", label: "See Net worth" },
};

function tenths(n: number): string {
  return n % 10 === 0 ? String(n / 10) : `${Math.floor(n / 10)}.${n % 10}`;
}

/** One plain line of where a step stands; null for nothing to add. */
export function stepLine(step: PathStep): string {
  if (step.state === "done") {
    if (step.clear) return "No cards to check";
    return step.reached_on ? `Reached ${formatDay(step.reached_on)}` : "Reached";
  }
  if (step.state === "skipped") return "Skipped";
  const { have, need } = step;
  switch (step.id) {
    case "setup":
      return `${have ?? 0} of ${need} set: pay, a budget and a balance`;
    case "cushion":
      return have === null
        ? "Add your balance to check"
        : `${formatCents(Math.max(0, have))} of ${formatCents(need)} in checking`;
    case "starter":
      return `${formatCents(have ?? 0)} of ${formatCents(need)} in Emergency fund`;
    case "paid_in_full":
      return have === null ? "Needs card statements" : `${have} of ${need} months in a row`;
    case "debts":
      return `${formatCents(have ?? 0)} left, home loan aside`;
    case "three_months":
      return have === null
        ? "Add your essentials to check"
        : `Runway ${tenths(have)} of ${tenths(need)} months`;
    case "later":
      return "Anything in investments or retirement";
  }
}

/** Whole numbers for the progress bar, or null when a step has no sensible bar. */
function barOf(step: PathStep): { value: number; max: number; text: string } | null {
  if (step.have === null || step.id === "debts" || step.id === "later") return null;
  if (step.need <= 0) return null;
  return {
    value: Math.max(0, Math.min(step.have, step.need)),
    max: step.need,
    text: stepLine(step),
  };
}

function AdjustSheet({
  open,
  onClose,
  steps,
  layout,
}: {
  open: boolean;
  onClose: () => void;
  steps: PathStep[];
  layout: PathLayout;
}) {
  const { db } = useDb();
  const ids = useId();
  const [order, setOrder] = useState<PathStepId[]>(() => steps.map((s) => s.id));
  const [skipped, setSkipped] = useState<Set<PathStepId>>(() => new Set(layout.skipped));
  const [names, setNames] = useState<Partial<Record<PathStepId, string>>>(() => ({
    ...layout.names,
  }));
  function move(index: number, delta: number) {
    const next = [...order];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [id] = next.splice(index, 1);
    next.splice(target, 0, id as PathStepId);
    setOrder(next);
  }
  async function save() {
    const kept: Partial<Record<PathStepId, string>> = {};
    for (const [id, name] of Object.entries(names) as Array<[PathStepId, string | undefined]>) {
      const t = (name ?? "").trim();
      if (t && t !== STEP_NAMES[id]) kept[id] = t.slice(0, NAME_MAX);
    }
    await savePathLayout(db, { order, skipped: [...skipped], names: kept });
    onClose();
  }
  async function reset() {
    await savePathLayout(db, { order: [], skipped: [], names: {} });
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title="Adjust your path">
      <p className="sk-card__eyebrow">Your order, your names. Skipped steps stay off the count.</p>
      <ol className="path-list" aria-label="Steps">
        {order.map((id, i) => (
          <li className="path-adjust__row" key={id}>
            <div>
              <label className="sr-only" htmlFor={`${ids}-${id}`}>
                Name for {STEP_NAMES[id]}
              </label>
              <input
                id={`${ids}-${id}`}
                className="auth__input path-adjust__name"
                value={names[id] ?? STEP_NAMES[id]}
                maxLength={NAME_MAX}
                onChange={(e) => setNames({ ...names, [id]: e.target.value })}
              />
              <label className="sk-card__eyebrow">
                <input
                  type="checkbox"
                  checked={!skipped.has(id)}
                  onChange={(e) => {
                    const next = new Set(skipped);
                    if (e.target.checked) next.delete(id);
                    else next.add(id);
                    setSkipped(next);
                  }}
                />{" "}
                Show this step
              </label>
            </div>
            <div className="path-adjust__moves">
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Move ${names[id] ?? STEP_NAMES[id]} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Move ${names[id] ?? STEP_NAMES[id]} down`}
                disabled={i === order.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="streak-card__actions">
        <Button block onClick={() => void save()}>
          Save
        </Button>
        <Button block variant="secondary" onClick={() => void reset()}>
          Back to the usual order
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * Your path (owner decision, November 19, 2026; the canvas's C1): seven steps in a common order,
 * each reached once from the person's own data and kept with its date (`streaks.path`). The
 * person can skip, reorder or rename any step. Education, not advice, and it says so.
 */
export function PathScreen() {
  const today = todayIso();
  const progress = useProgress(today);
  const [adjusting, setAdjusting] = useState(false);
  const path = progress.path;
  const current = path?.steps.find((s) => s.state === "current") ?? null;
  const counted = (path?.steps ?? []).filter((s) => s.state !== "skipped");
  const number = current ? counted.findIndex((s) => s.id === current.id) + 1 : 0;
  return (
    <>
      <ScreenHeader
        title="Your path"
        back="/goals?tab=streaks"
        actions={
          path ? (
            <Button size="sm" variant="secondary" onClick={() => setAdjusting(true)}>
              Adjust
            </Button>
          ) : null
        }
      />
      {!path ? (
        <p className="sk-card__eyebrow">Reading your steps…</p>
      ) : (
        <>
          <Card as="section" aria-labelledby="path-summary">
            <h2 className="sk-card__title" id="path-summary">
              Where you are
            </h2>
            <Word>{current ? `Step ${number} of ${path.total}` : "Done"}</Word>
            <p className="sk-card__eyebrow">
              {current
                ? `${path.done} done. ${stepName(current.id, progress.layout)} is next.`
                : "Every step reached. Keep it going."}
            </p>
          </Card>
          <ol className="path-list" aria-label="Steps">
            {path.steps.map((step, i) => {
              const bar = step.state === "current" ? barOf(step) : null;
              const link = STEP_LINKS[step.id];
              return (
                <li className={`path-step path-step--${step.state}`} key={step.id}>
                  <div className="path-step__rail" aria-hidden="true">
                    <span className={`path-step__dot path-step__dot--${step.state}`}>
                      {step.state === "done" ? "✓" : String(i + 1)}
                    </span>
                    {i < path.steps.length - 1 ? (
                      <span
                        className={`path-step__line${step.state === "done" ? " path-step__line--done" : ""}`}
                      />
                    ) : null}
                  </div>
                  <div className="path-step__body">
                    {step.state === "current" ? (
                      <Card as="section" aria-labelledby={`step-${step.id}`}>
                        <h2 className="path-step__name" id={`step-${step.id}`}>
                          {stepName(step.id, progress.layout)}
                        </h2>
                        <p className="path-step__line-text">{stepLine(step)}</p>
                        {bar ? (
                          <ProgressBar
                            fraction={bar.value / bar.max}
                            tone="success"
                            label={stepName(step.id, progress.layout)}
                            valueText={bar.text}
                          />
                        ) : null}
                        <Link
                          to={link.to}
                          className={buttonClass({ size: "sm", variant: "secondary" })}
                        >
                          {link.label}
                        </Link>
                      </Card>
                    ) : (
                      <>
                        <p className="path-step__name">
                          <span className="sr-only">
                            {step.state === "done"
                              ? "Done: "
                              : step.state === "skipped"
                                ? "Skipped: "
                                : "Later: "}
                          </span>
                          {stepName(step.id, progress.layout)}
                        </p>
                        <p className="path-step__line-text">{stepLine(step)}</p>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="auth__fineprint">
            A common order, not advice. Skip, reorder or rename any step.
          </p>
          {adjusting ? (
            <AdjustSheet
              open
              onClose={() => setAdjusting(false)}
              steps={path.steps}
              layout={progress.layout}
            />
          ) : null}
        </>
      )}
    </>
  );
}
