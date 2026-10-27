import "../auth/auth.css";
import "../forecast/forecast.css";
import "./later.css";

import { Card } from "@stackd/ui";
import { useEffect, useId, useRef, useState } from "react";
import { Arranged } from "../../app/layout/Arranged.tsx";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import {
  EngineError,
  growthProjection,
  type LaterProjection,
  parseAmount,
} from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { LaterChart } from "./LaterChart.tsx";
import { type LaterPlan, useLaterPlan } from "./useLaterPlan.ts";

/** "5%" from 500 basis points; "4.5%" from 450. */
const pct = (bps: number) => `${bps / 100}%`;

export function useLaterProjection(plan: LaterPlan | undefined): LaterProjection | null {
  const [result, setResult] = useState<LaterProjection | null>(null);
  useEffect(() => {
    if (!plan) return;
    let alive = true;
    growthProjection(plan)
      .then((r) => alive && setResult(r))
      .catch(() => alive && setResult(null));
    return () => {
      alive = false;
    };
  }, [plan]);
  return result;
}

/** The one-word verdict and its line (owner, October 25, 2026). */
export function laterStatus(
  plan: LaterPlan,
  p: LaterProjection,
): { word: "Ahead" | "Behind" | "Growing"; line: string } {
  const mid = p.at_retirement_cents[p.middle_index] ?? 0;
  const about = `About ${formatCents(mid)} at ${plan.retire_age} at ${pct(plan.rates_bps[p.middle_index] ?? 0)}`;
  if (p.reaches_target === true)
    return { word: "Ahead", line: `${about}, past your ${formatCents(p.target_cents)} goal.` };
  if (p.reaches_target === false)
    return {
      word: "Behind",
      line: `${about}. About ${formatCents(p.monthly_needed_cents ?? 0)} a month would reach ${formatCents(p.target_cents)}.`,
    };
  const lo = p.at_retirement_cents[0] ?? 0;
  const hi = p.at_retirement_cents[p.at_retirement_cents.length - 1] ?? 0;
  return {
    word: "Growing",
    line: `${about}; ${formatCents(lo)} to ${formatCents(hi)} across your rates.`,
  };
}

type Field = "age_now" | "retire_age" | "start" | "monthly" | "target" | "r0" | "r1" | "r2";

function asText(plan: LaterPlan): Record<Field, string> {
  return {
    age_now: String(plan.age_now),
    retire_age: String(plan.retire_age),
    start: String(plan.start_cents / 100),
    monthly: String(plan.monthly_cents / 100),
    target: plan.target_cents ? String(plan.target_cents / 100) : "",
    r0: String(plan.rates_bps[0] / 100),
    r1: String(plan.rates_bps[1] / 100),
    r2: String(plan.rates_bps[2] / 100),
  };
}

export const LATER_CARDS = [
  ["status", "Ahead or behind", "One word on your goal"],
  ["chart", "Savings by age", "The band at your rates"],
  ["yours", "Your numbers", "Ages, savings and rates"],
] as const;
type LaterCardId = (typeof LATER_CARDS)[number][0];

/** Later (October 25, 2026): the person's savings by the age they choose, at their own rates. */
export function LaterScreen() {
  const ids = useId();
  const [plan, save] = useLaterPlan();
  const p = useLaterProjection(plan);
  const [text, setText] = useState<Record<Field, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (plan && text === null) setText(asText(plan));
  }, [plan, text]);

  // Each keystroke checks its plan through the engine; only the newest may save or show an
  // error, so an older one answering late never overwrites it (October 27, 2026).
  const latest = useRef(0);
  async function change(field: Field, value: string) {
    if (!text || !plan) return;
    const next = { ...text, [field]: value };
    setText(next);
    const mine = ++latest.current;
    try {
      const age = Number.parseInt(next.age_now, 10);
      const retire = Number.parseInt(next.retire_age, 10);
      if (!Number.isInteger(age) || !Number.isInteger(retire)) throw new Error("age");
      const rates = await Promise.all(
        [next.r0, next.r1, next.r2].map((r) => parseAmount(r || "0")),
      );
      const candidate: LaterPlan = {
        age_now: age,
        retire_age: retire,
        start_cents: await parseAmount(next.start || "0"),
        monthly_cents: await parseAmount(next.monthly || "0"),
        target_cents: await parseAmount(next.target || "0"),
        rates_bps: [rates[0] ?? 0, rates[1] ?? 0, rates[2] ?? 0],
      };
      await growthProjection(candidate); // the engine checks every field
      if (mine !== latest.current) return;
      setError(null);
      await save(candidate);
    } catch (e) {
      if (mine !== latest.current) return;
      setError(
        e instanceof EngineError && e.code === "too_large"
          ? "That grows past what can be counted to the cent. Try a lower rate or amount."
          : "Ages 16 to 100 with retiring after now, amounts like 250, and rates from low to high, like 3, 5, 7.",
      );
    }
  }

  const status = plan && p ? laterStatus(plan, p) : null;
  const field = (name: Field, label: string, mode: "numeric" | "decimal", placeholder = "") =>
    text ? (
      <label className="auth__field">
        <span className="auth__label">{label}</span>
        <input
          id={`${ids}-${name}`}
          className="auth__input"
          inputMode={mode}
          placeholder={placeholder}
          value={text[name]}
          onChange={(e) => void change(name, e.target.value)}
        />
      </label>
    ) : null;

  const card = (id: LaterCardId) => {
    switch (id) {
      case "status":
        return (
          <>
            {status && p ? (
              <Card
                as="section"
                aria-label={status.word}
                className={status.word === "Behind" ? "forecast__warn" : "forecast__status--ok"}
              >
                <h2 className="forecast__status-word">{status.word}</h2>
                <p>{status.line}</p>
              </Card>
            ) : null}
          </>
        );
      case "chart":
        return (
          <>
            {p ? (
              <Card as="section" aria-label="Savings by age">
                <span className="sk-card__eyebrow">Your savings by age</span>
                <LaterChart p={p} />
              </Card>
            ) : null}
          </>
        );
      case "yours":
        return (
          <>
            {text && plan ? (
              <Card as="section" aria-label="Your numbers">
                <h2 className="sk-card__title">Yours</h2>
                <p className="auth__hint">Every number here is yours to change.</p>
                <label className="later__retire">
                  <span>
                    Retire at <strong>{text.retire_age}</strong>
                  </span>
                  <input
                    type="range"
                    min={Math.max(plan.age_now + 1, 40)}
                    max={80}
                    value={plan.retire_age}
                    aria-valuetext={`Age ${plan.retire_age}`}
                    onChange={(e) => void change("retire_age", e.target.value)}
                  />
                </label>
                <div className="tiles" style={{ gap: 8 }}>
                  {field("age_now", "Age now", "numeric")}
                  {field("retire_age", "Retire at", "numeric")}
                  {field("start", "Saved now", "decimal", "0")}
                  {field("monthly", "Each month", "decimal", "200")}
                  {field("target", "Goal (optional)", "decimal", "e.g. 500,000")}
                </div>
                <fieldset className="later__rates">
                  <legend className="auth__label">Your yearly rates, %</legend>
                  <div className="tiles" style={{ gap: 8 }}>
                    {field("r0", "Low", "decimal")}
                    {field("r1", "Middle", "decimal")}
                    {field("r2", "High", "decimal")}
                  </div>
                </fieldset>
                {error ? (
                  <p className="auth__error" role="alert">
                    {error}
                  </p>
                ) : null}
              </Card>
            ) : null}
          </>
        );
    }
  };

  return (
    <>
      <ScreenHeader title="Later" back="/insights" />
      <Arranged screen="later" name="Later" cards={LATER_CARDS} render={card} />
      <p className="auth__fineprint">
        An illustration at the rates you set, not a prediction or advice. Returns vary and can be
        negative.
      </p>
    </>
  );
}
