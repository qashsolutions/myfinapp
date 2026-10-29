import "./goals.css";
import "../entries/entries.css";
import "../auth/auth.css";

import { Button, Card, SentenceBuilder, type SentencePart, Sheet, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type GoalCadence,
  type GoalKind,
  type GoalTemplate,
  ignoreClosed,
  type PaySettings,
} from "../../data/db.ts";
import {
  addMonths,
  customJar,
  EngineError,
  goalMilestones,
  goalPlan,
  goalProgress,
  growGoalPlan,
  monthBounds,
  parseAmount,
  spendLessBaseline,
} from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import {
  checkpointsText,
  parseCheckpoints,
  parsePercentBps,
  parseWholeNumber,
  percentText,
} from "../../lib/ownValues.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { payScheduleOf } from "../home/useHome.ts";
import { useHouseholdLocal, useHouseholdStatus } from "../household/useHousehold.ts";
import { ChipsOrOwn, CustomValueSheet } from "./CustomValueSheet.tsx";
import { CADENCE_WORDS } from "./GoalCard.tsx";
import { growLineOf, growMessage } from "./grow.ts";
import {
  AMOUNTS,
  DEADLINE_MONTHS,
  DEFAULT_MILESTONES_BPS,
  DEFAULT_RETURN_BPS,
  DEFAULT_RISE_BPS,
  GROW_RETURN_BPS,
  GROW_RISE_BPS,
  GROWS_WHAT,
  HABIT_DAYS,
  HABIT_WHAT,
  KIND_LABELS,
  MILESTONE_SETS,
  PAYOFF_WHAT,
  SPEND_LESS_AMOUNTS,
  WHAT_FOR,
} from "./presets.ts";
import { activeGoalCount, useGoalCaps } from "./useGoalCaps.ts";
import { createGoal, ensureMilestones, useTemplates } from "./useGoals.ts";

type Blank = "what" | "amount" | "when" | "days" | "category" | "baseline" | "cadence" | null;
const MAX_HABIT_DAYS = 365;
type When =
  | { kind: "months"; months: number }
  | { kind: "none" }
  | { kind: "custom"; date: string };

const DEFAULT_WHEN: When = { kind: "months", months: DEADLINE_MONTHS[1] as number };

function whatPresets(kind: GoalKind): string[] {
  return kind === "payoff" ? PAYOFF_WHAT : kind === "habit" ? HABIT_WHAT : WHAT_FOR;
}

function amountPresets(kind: GoalKind): number[] {
  return kind === "spend_less" ? SPEND_LESS_AMOUNTS : AMOUNTS;
}

/** Spend-less goals run to the end of the current month (engine month bounds). */
async function monthEnd(today: string): Promise<string> {
  return (await monthBounds(today)).end;
}

/** Plain-language text for the custom-jar rule's error codes. */
function customMessage(err: unknown): string {
  switch (err instanceof EngineError ? err.code : "") {
    case "invalid_name":
      return "Give it a name, up to 10 characters.";
    case "deadline_in_past":
      return "Pick a date after today.";
    case "invalid_date":
      return "Pick a date.";
    default:
      return "Enter an amount like 1,500.";
  }
}

/**
 * New goal (mockups F4Builder, GoalBuilder): pick a kind, fill the blanks from presets or type
 * your own name, amount or date (validated by `goals_custom.jar`), see the weekly pace from the
 * engine, create. Milestones, why lines and cadences are fast-follow 3.
 */
export function GoalBuilder() {
  const { db } = useDb();
  const navigate = useNavigate();
  const ids = useId();
  const today = todayIso();
  const categories = useLiveQuery(
    async () =>
      (await db.categories.where("kind").equals("expense").sortBy("sort")).filter((c) => !c.hidden),
    [db],
  );
  const [kind, setKind] = useState<GoalKind>("save");
  const [what, setWhat] = useState<string>(WHAT_FOR[0] as string);
  const [amount, setAmount] = useState<number>(AMOUNTS[2] as number);
  const [when, setWhen] = useState<When>(DEFAULT_WHEN);
  const [deadline, setDeadline] = useState<string | null>(null);
  const [days, setDays] = useState<number>(HABIT_DAYS[0] as number);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [baselineText, setBaselineText] = useState("");
  const [baseline, setBaseline] = useState<number | null>(null);
  const [open, setOpen] = useState<Blank>(null);
  const [pace, setPace] = useState<{ weekly: number | null; weeks: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caps = useGoalCaps();
  const [capHit, setCapHit] = useState(false);
  // fast-follow 3: cadence, ongoing, why line, milestones, templates
  const [cadence, setCadence] = useState<GoalCadence | null>(null);
  const [ongoing, setOngoing] = useState(false);
  const [why, setWhy] = useState("");
  const [withMilestones, setWithMilestones] = useState(true);
  const [milestonesBps, setMilestonesBps] = useState<number[]>(DEFAULT_MILESTONES_BPS);
  const [planLine, setPlanLine] = useState<string | null>(null);
  // October 28, 2026: a jar that grows over time (growth.goal_plan)
  const [grow, setGrow] = useState(false);
  const [riseBps, setRiseBps] = useState(DEFAULT_RISE_BPS);
  const [returnBps, setReturnBps] = useState(DEFAULT_RETURN_BPS);
  const [growLine, setGrowLine] = useState<string>("");
  const growing = kind === "save" && grow && !ongoing;
  const templates = useTemplates();
  const pay = useLiveQuery(
    async () => ((await db.settings.get("pay"))?.value as PaySettings | undefined) ?? null,
    [db],
  );
  const household = useHouseholdLocal();
  const { status: householdStatus } = useHouseholdStatus();
  const partner = householdStatus?.household?.members.find((m) => !m.is_me) ?? null;
  const canShare = kind === "save" && !!household?.householdId && household.hasKey && !!partner;
  const [share, setShare] = useState(false);

  function pickKind(next: GoalKind) {
    if (next === kind) return;
    setKind(next);
    setWhat(
      next === "spend_less"
        ? (categories?.find((c) => c.id === categoryId)?.name ?? "")
        : (whatPresets(next)[0] as string),
    );
    setAmount(amountPresets(next)[2] as number);
  }

  useEffect(() => {
    let alive = true;
    if (when.kind === "none") {
      setDeadline(null);
      return;
    }
    if (when.kind === "custom") {
      setDeadline(when.date);
      return;
    }
    void addMonths(today, when.months).then((d) => {
      if (alive) setDeadline(d);
    });
    return () => {
      alive = false;
    };
  }, [when, today]);

  function pickWhat(next: string) {
    setWhat(next);
    const rise = GROWS_WHAT[next];
    if (kind === "save" && rise !== undefined) {
      setGrow(true);
      setOngoing(false);
      setRiseBps(rise);
    }
  }

  useEffect(() => {
    if (!growing) return;
    if (!deadline) {
      setGrowLine(growMessage(null));
      return;
    }
    let alive = true;
    void growGoalPlan({
      today_cost_cents: amount,
      cost_rise_bps: riseBps,
      return_bps: returnBps,
      saved_cents: 0,
      as_of: today,
      target_date: deadline,
    })
      .then((g) => {
        if (alive) setGrowLine(growLineOf(g.monthly_needed_cents, g.future_cost_cents, deadline));
      })
      .catch((err) => {
        if (alive) setGrowLine(growMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [growing, amount, riseBps, returnBps, deadline, today]);

  useEffect(() => {
    if (kind !== "spend_less" || categoryId || !categories?.length) return;
    const dining = categories.find((c) => c.id === "cat-dining") ?? categories[0];
    if (dining) {
      setCategoryId(dining.id);
      setWhat(dining.name);
    }
  }, [kind, categories, categoryId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await goalProgress(
          kind === "habit"
            ? { kind, target_days: days, start_date: today, end_date: null }
            : kind === "spend_less"
              ? {
                  kind,
                  target_cents: amount,
                  start_date: today,
                  end_date: await monthEnd(today),
                  baseline_cents: baseline ?? 0,
                  period_spend_cents: 0,
                }
              : { kind, target_cents: amount, start_date: today, end_date: deadline },
          [],
          today,
        );
        if (alive) setPace({ weekly: p.weekly_pace, weeks: p.weeks_left });
      } catch {
        if (alive) setPace(null);
      }
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [kind, amount, days, deadline, baseline, today]);

  async function commitName(text: string): Promise<string | null> {
    try {
      const r = await customJar(text, amount, deadline, today);
      setWhat(r.goal.title);
      return null;
    } catch (err) {
      return customMessage(err);
    }
  }

  async function commitAmount(text: string): Promise<string | null> {
    try {
      const cents = await parseAmount(text);
      const r = await customJar(what || "Jar", cents, deadline, today);
      setAmount(r.goal.target_cents);
      return null;
    } catch (err) {
      return customMessage(err);
    }
  }

  async function commitDate(text: string): Promise<string | null> {
    try {
      const r = await customJar(what || "Jar", amount, text, today);
      setWhen({ kind: "custom", date: r.goal.end_date ?? text });
      return null;
    } catch (err) {
      return customMessage(err);
    }
  }

  async function commitBaseline() {
    try {
      const estimate = await parseAmount(baselineText);
      const value = await spendLessBaseline(estimate, []);
      setBaseline(value);
      setOpen(null);
    } catch {
      setError("Enter what you usually spend, like 380.");
    }
  }

  useEffect(() => {
    if (kind !== "save" || !cadence || pay === undefined || growing) {
      setPlanLine(null);
      return;
    }
    const schedule = payScheduleOf(pay ?? undefined);
    if (cadence === "payday" && !schedule) {
      setPlanLine("Set your pay dates in Budget to plan by paycheck.");
      return;
    }
    if (ongoing) {
      setPlanLine(
        `${formatCents(amount)} ${CADENCE_WORDS[cadence]}, as long as you like. The streak counts each time you do.`,
      );
      return;
    }
    let alive = true;
    void goalPlan(
      { kind: "save", target_cents: amount, start_date: today, end_date: deadline, cadence },
      [],
      today,
      schedule,
    )
      .then((p) => {
        if (!alive) return;
        const noun = {
          weekly: ["week", "weeks"],
          biweekly: ["2 weeks", "periods"],
          monthly: ["month", "months"],
          payday: ["paycheck", "paychecks"],
        }[cadence];
        setPlanLine(
          p.needs_amount
            ? "Pick a deadline to see the amount each time."
            : `${formatCents(p.per_period_cents ?? 0)} ${cadence === "biweekly" ? "every 2 weeks" : `a ${noun[0]}`} · ${p.periods_left} ${p.periods_left === 1 ? noun[0] : noun[1]} to ${formatCents(amount)} · first deposit ${formatDay(p.next_date)}`,
        );
      })
      .catch(() => {
        if (alive) setPlanLine(null);
      });
    return () => {
      alive = false;
    };
  }, [kind, cadence, ongoing, amount, deadline, today, pay, growing]);

  function applyTemplate(t: GoalTemplate) {
    const p = t.payload;
    setKind(p.kind);
    setWhat(p.title);
    if (p.target_cents) setAmount(p.target_cents);
    setWhen(p.months ? { kind: "months", months: p.months } : { kind: "none" });
    setCadence(p.cadence);
    setOngoing(p.is_ongoing);
    if (p.is_ongoing && p.per_period_cents) setAmount(p.per_period_cents);
    setWhy(p.why_text ?? "");
    setWithMilestones(p.milestones_bps.length > 0);
    if (p.milestones_bps.length > 0) setMilestonesBps(p.milestones_bps);
  }

  async function create() {
    setError(null);
    if (caps.max !== null && (await activeGoalCount(db)) >= caps.max) {
      setCapHit(true);
      return;
    }
    if (kind === "spend_less" && baseline === null) {
      setError("Tell us what you usually spend on this first.");
      setOpen("baseline");
      return;
    }
    let target = amount;
    if (growing) {
      try {
        if (!deadline) throw new EngineError("invalid_date");
        target = (
          await growGoalPlan({
            today_cost_cents: amount,
            cost_rise_bps: riseBps,
            return_bps: returnBps,
            saved_cents: 0,
            as_of: today,
            target_date: deadline,
          })
        ).future_cost_cents;
      } catch (err) {
        setError(growMessage(err));
        return;
      }
    }
    const goal = await createGoal(db, {
      kind,
      title: what,
      target_cents: kind === "habit" ? null : target,
      target_days: kind === "habit" ? days : null,
      label: kind === "habit" ? what : null,
      category_id: kind === "spend_less" ? categoryId : null,
      start_date: today,
      end_date: kind === "habit" ? null : kind === "spend_less" ? await monthEnd(today) : deadline,
      baseline_cents: kind === "spend_less" ? baseline : null,
      group_id: null,
      household_id: share && canShare ? household.householdId : null,
      cadence: kind === "save" && !growing ? cadence : null,
      per_period_cents: kind === "save" && ongoing ? amount : null,
      is_ongoing: kind === "save" && ongoing && !!cadence,
      paused_at: null,
      pauses: [],
      priority: null,
      why_text: why.trim() || null,
      milestones_bps: kind === "save" && !ongoing && withMilestones ? milestonesBps : [],
      grow: growing
        ? { today_cents: amount, cost_rise_bps: riseBps, return_bps: returnBps, priced_on: today }
        : null,
    });
    if (goal.milestones_bps?.length && goal.target_cents)
      await ensureMilestones(
        db,
        goal,
        await goalMilestones(goal.target_cents, 0, goal.milestones_bps),
      );
    navigate(`/goals/${goal.id}`, { replace: true });
  }

  const parts: SentencePart[] = (() => {
    const amountBlank: SentencePart = {
      key: "amount",
      label: formatCents(amount),
      change: "Change amount",
      onClick: () => setOpen("amount"),
    };
    const whenBlank: SentencePart = {
      key: "when",
      label: deadline ? formatDay(deadline) : "no deadline",
      change: "Change deadline",
      onClick: () => setOpen("when"),
    };
    const cadenceBlank: SentencePart = {
      key: "cadence",
      label: cadence ? (CADENCE_WORDS[cadence] ?? cadence) : "just by the date",
      change: "Change how often",
      onClick: () => setOpen("cadence"),
    };
    const whatBlank: SentencePart = {
      key: "what",
      label: what,
      change: "Change what it's for",
      onClick: () => setOpen("what"),
    };
    switch (kind) {
      case "save":
        if (growing)
          return [
            "Save for ",
            whatBlank,
            ", costing ",
            { ...amountBlank, label: `${formatCents(amount)} today` },
            " by ",
            whenBlank,
          ];
        if (ongoing && cadence)
          return ["Save ", amountBlank, " for ", whatBlank, " ", cadenceBlank];
        return ["Save ", amountBlank, " for ", whatBlank, " by ", whenBlank, ", ", cadenceBlank];
      case "payoff":
        return ["Pay off ", amountBlank, " on ", whatBlank, " by ", whenBlank];
      case "spend_less":
        return [
          "Spend ",
          amountBlank,
          " less on ",
          {
            key: "category",
            label: what,
            change: "Change category",
            onClick: () => setOpen("category"),
          },
          " during ",
          {
            key: "period",
            label: "this month",
            change: "Period",
            onClick: () => {},
            disabled: true,
          },
        ];
      case "habit":
        return [
          "Do ",
          {
            key: "days",
            label: `${days} days`,
            change: "Change days",
            onClick: () => setOpen("days"),
          },
          " of ",
          { key: "what", label: what, change: "Change what", onClick: () => setOpen("what") },
          " starting ",
          { key: "start", label: "today", change: "Start", onClick: () => {}, disabled: true },
        ];
    }
  })();

  const paceLine = !pace
    ? ""
    : kind === "habit"
      ? `${days} check-ins, one a day`
      : pace.weekly === null
        ? "No deadline, no pace"
        : `${formatCents(pace.weekly)} a week · ${pace.weeks} ${pace.weeks === 1 ? "week" : "weeks"} to ${formatCents(amount)}`;

  return (
    <>
      <ScreenHeader title="New goal" actions={null} back="/goals" />
      <fieldset className="kind-chips" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="sr-only">Goal type</legend>
        {(Object.keys(KIND_LABELS) as GoalKind[]).map((k) => (
          <label className="chip-option" key={k}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-kind`}
              value={k}
              checked={kind === k}
              onChange={() => pickKind(k)}
            />
            {KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      {templates && templates.length > 0 ? (
        <fieldset className="kind-chips" style={{ border: 0, margin: "0 0 8px", padding: 0 }}>
          <legend className="auth__label">My templates</legend>
          {templates.map((t) => (
            <Button key={t.id} size="sm" variant="secondary" onClick={() => applyTemplate(t)}>
              {t.name}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <SentenceBuilder parts={parts} />
      {kind === "save" ? (
        <Card as="section" aria-label="Jar options">
          {!ongoing ? (
            <Toggle
              checked={grow}
              onChange={setGrow}
              label="Grows over time"
              description="For goals years away: the cost goes up each year, and what you save can grow."
            />
          ) : null}
          {growing ? (
            <>
              <ChipsOrOwn
                name={`${ids}-rise`}
                legend="The cost rises each year by"
                options={GROW_RISE_BPS.map((b) => [String(b), percentText(b)])}
                value={String(riseBps)}
                display={(v) => percentText(Number(v))}
                onPick={(v) => setRiseBps(Number(v))}
                own={{
                  label: "Your own yearly rise, in percent",
                  placeholder: "Or your own, like 4.5",
                  inputMode: "decimal",
                  parse: (t) => {
                    const bps = parsePercentBps(t);
                    return bps === null
                      ? { error: "A percent from 0 to 500, like 4.5." }
                      : { value: String(bps) };
                  },
                }}
              />
              <ChipsOrOwn
                name={`${ids}-return`}
                legend="What you save grows each year by"
                options={GROW_RETURN_BPS.map((b) => [String(b), percentText(b)])}
                value={String(returnBps)}
                display={(v) => percentText(Number(v))}
                onPick={(v) => setReturnBps(Number(v))}
                own={{
                  label: "Your own yearly growth, in percent",
                  placeholder: "Or your own, like 0 for cash",
                  inputMode: "decimal",
                  parse: (t) => {
                    const bps = parsePercentBps(t);
                    return bps === null
                      ? { error: "A percent from 0 to 500, like 4.5." }
                      : { value: String(bps) };
                  },
                }}
              />
              <p className="auth__fineprint">
                An illustration at the rates you chose, not a prediction or advice.
              </p>
            </>
          ) : null}
          {cadence && !growing ? (
            <Toggle
              checked={ongoing}
              onChange={setOngoing}
              label="No end: keep saving this amount each time"
              description="An ongoing jar has no target; it counts your streak instead."
            />
          ) : null}
          {!ongoing ? (
            <>
              <Toggle
                checked={withMilestones}
                onChange={setWithMilestones}
                label={`Milestones at ${checkpointsText(milestonesBps)}`}
                description="Each one gets its own cheer, and an alert if you turn those on."
              />
              {withMilestones ? (
                <ChipsOrOwn
                  name={`${ids}-milestones`}
                  legend="Cheer at"
                  options={MILESTONE_SETS.map((set) => [set.join(","), checkpointsText(set)])}
                  value={milestonesBps.join(",")}
                  display={(v) => checkpointsText(v.split(",").map(Number))}
                  onPick={(v) => setMilestonesBps(v.split(",").map(Number))}
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
              ) : null}
            </>
          ) : null}
          <label className="auth__field" style={{ marginTop: 8 }}>
            <span className="auth__label">Why it matters (optional)</span>
            <input
              className="auth__input"
              value={why}
              maxLength={80}
              placeholder="e.g. Lisbon with Sam, next June"
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
          {planLine ? (
            <p className="sk-card__eyebrow" role="status">
              {planLine}
            </p>
          ) : null}
        </Card>
      ) : null}
      {canShare && partner ? (
        <Card as="section" aria-label="Share with your partner">
          <Toggle
            checked={share}
            onChange={setShare}
            label={`Share with ${partner.display_name}`}
            description="Both of you can log deposits; the jar shows who added what."
          />
        </Card>
      ) : null}
      <Card tone="accent" as="section" aria-label="Pace">
        <p className="sk-card__eyebrow">{kind === "save" ? `${what} jar` : KIND_LABELS[kind]}</p>
        <p className="sk-card__hero sk-card__hero--empty" role="status">
          {growing ? growLine : paceLine}
        </p>
        {kind === "spend_less" ? (
          <p>
            {baseline === null
              ? "Usual spend not set yet."
              : `Against your usual ${formatCents(baseline)} a month.`}{" "}
            <button
              type="button"
              className="auth__link"
              style={{ color: "inherit" }}
              onClick={() => setOpen("baseline")}
            >
              {baseline === null ? "Set it" : "Change"}
            </button>
          </p>
        ) : null}
      </Card>
      {capHit ? (
        <PlanLimit>
          Your plan has room for {caps.max} jars and goals, and you have {caps.active}. Move a
          finished one to your templates to free its place. Finish or remove one first, or choose a
          bigger plan. Nothing is ever deleted.
        </PlanLimit>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={create}>
        {kind === "save" ? "Create jar" : "Create goal"}
      </Button>
      <p className="auth__fineprint">Jars are virtual. Logging money here never moves it.</p>

      <CustomValueSheet
        open={open === "what"}
        onClose={() => setOpen(null)}
        title={kind === "habit" ? "What will you do?" : "What's it for?"}
        name={`${ids}-what`}
        options={whatPresets(kind).map((w) => [w, w])}
        value={what}
        onPick={pickWhat}
        custom={{
          label: "Or name your own",
          placeholder: "e.g. New laptop",
          type: "text",
          commit: commitName,
        }}
      />
      <CustomValueSheet
        open={open === "amount"}
        onClose={() => setOpen(null)}
        title="How much?"
        name={`${ids}-amount`}
        options={amountPresets(kind).map((a) => [String(a), formatCents(a)])}
        value={String(amount)}
        onPick={(v) => setAmount(Number(v))}
        custom={{
          label: "Or any amount",
          placeholder: "1,500",
          type: "decimal",
          commit: commitAmount,
        }}
      />
      <CustomValueSheet
        open={open === "when"}
        onClose={() => setOpen(null)}
        title="By when?"
        name={`${ids}-when`}
        options={[
          ...DEADLINE_MONTHS.map((m) => [String(m), `In ${m} months`] as [string, string]),
          ["none", "No deadline"],
        ]}
        value={when.kind === "months" ? String(when.months) : when.kind === "none" ? "none" : ""}
        onPick={(v) =>
          setWhen(v === "none" ? { kind: "none" } : { kind: "months", months: Number(v) })
        }
        custom={{ label: "Or pick a date", type: "date", min: today, commit: commitDate }}
      />
      <CustomValueSheet
        open={open === "cadence"}
        onClose={() => setOpen(null)}
        title="How often?"
        name={`${ids}-cadence`}
        options={[
          ["none", "Just by the date"],
          ["weekly", "Every week"],
          ["biweekly", "Every 2 weeks"],
          ["monthly", "Every month"],
          ["payday", "Every paycheck"],
        ]}
        value={cadence ?? "none"}
        onPick={(v) => {
          setCadence(v === "none" ? null : (v as GoalCadence));
          if (v === "none") setOngoing(false);
        }}
      />
      <CustomValueSheet
        open={open === "days"}
        onClose={() => setOpen(null)}
        title="How many days?"
        name={`${ids}-days`}
        options={HABIT_DAYS.map((d) => [String(d), `${d} days`])}
        value={String(days)}
        onPick={(v) => setDays(Number(v))}
        custom={{
          label: "Or any number of days",
          placeholder: `1 to ${MAX_HABIT_DAYS}`,
          type: "decimal",
          commit: async (text) => {
            const n = parseWholeNumber(text, 1, MAX_HABIT_DAYS);
            if (n === null) return `Pick a whole number of days from 1 to ${MAX_HABIT_DAYS}.`;
            setDays(n);
            return null;
          },
        }}
      />
      <CustomValueSheet
        open={open === "category"}
        onClose={() => setOpen(null)}
        title="Spend less on what?"
        name={`${ids}-category`}
        options={(categories ?? []).map((c) => [c.id, c.name])}
        value={categoryId ?? ""}
        onPick={(v) => {
          setCategoryId(v);
          setWhat(categories?.find((c) => c.id === v)?.name ?? what);
        }}
      />
      <Sheet
        open={open === "baseline"}
        onClose={() => setOpen(null)}
        title={`What do you usually spend on ${what} a month?`}
      >
        <p className="auth__hint">
          Your first month uses this estimate; later months use your last three months.
        </p>
        <label className="auth__field">
          <span className="auth__label">Usual monthly spend</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="380.00"
            value={baselineText}
            onChange={(e) => setBaselineText(e.target.value)}
          />
        </label>
        <Button block onClick={commitBaseline}>
          Use this
        </Button>
      </Sheet>
    </>
  );
}
