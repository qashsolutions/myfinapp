import "../auth/auth.css";
import "../entries/entries.css";

import { Button, Card, ProgressBar, Sheet } from "@stackd/ui";
import { useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { saveEmergencyFund, useEmergencySummary } from "./useEmergency.ts";

function monthsText(n: number): string {
  return `${n} ${n === 1 ? "month" : "months"}`;
}

/**
 * The emergency fund is a jar with runway (mockup F5Emergency, inside the jar's screen at
 * launch): runway if income stopped, the 3- or 6-month target, the starter / one-month /
 * target milestones and when the plan gets there.
 */
export function EmergencySection({ savedCents }: { savedCents: number }) {
  const { db } = useDb();
  const ids = useId();
  const { fund, essentialsCents, essentialsFromBudget, summary } = useEmergencySummary(savedCents);
  const [open, setOpen] = useState(false);
  const [essentialsText, setEssentialsText] = useState("");
  const [planText, setPlanText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!fund) return null;

  async function save() {
    setError(null);
    try {
      const essentials = essentialsText.trim() ? await parseAmount(essentialsText) : null;
      const plan = planText.trim() ? await parseAmount(planText) : null;
      if ((essentials !== null && essentials < 0) || (plan !== null && plan < 0))
        throw new Error("negative");
      await saveEmergencyFund(db, {
        essentials_cents: essentials ?? fund?.essentials_cents ?? null,
        monthly_plan_cents: plan ?? fund?.monthly_plan_cents ?? null,
      });
      setOpen(false);
    } catch {
      setError("Enter amounts like 3,062 and 154.");
    }
  }

  const runway = summary?.runway_tenths ?? null;
  const starter = summary?.milestones.find((m) => m.key === "starter");
  const target = summary?.milestones.find((m) => m.key === "target");
  const labels: Record<string, string> = {
    starter: "Starter fund",
    one_month: "1 month of essentials",
    target: `${fund.target_months} months`,
  };

  return (
    <>
      <Card tone="accent" as="section" aria-label="Runway">
        <p className="sk-card__eyebrow">Runway if income stopped</p>
        <p className="sk-card__hero">
          {runway === null ? "Add your essentials" : `${(runway / 10).toFixed(1)} months`}
        </p>
        <p>
          {formatCents(savedCents)} saved
          {essentialsCents > 0
            ? ` · essentials ${formatCents(essentialsCents)}/month${essentialsFromBudget ? " (needs from your budget)" : ""}`
            : " · what do your essentials cost each month?"}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Edit essentials and plan
        </Button>
      </Card>
      <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
        <legend className="sr-only">Target</legend>
        {([3, 6] as const).map((months) => (
          <label className="segmented__option" key={months}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-target`}
              value={months}
              checked={fund.target_months === months}
              onChange={() => void saveEmergencyFund(db, { target_months: months })}
            />
            {months}-month target
          </label>
        ))}
      </fieldset>
      <Card as="section" aria-label="Milestones">
        {summary?.milestones.map((m) => (
          <div key={m.key} style={{ padding: "6px 0" }}>
            <div className="hero-split">
              <span className="receipt-card__title">{labels[m.key]}</span>
              <span className="lb__pct">
                {formatCents(Math.min(savedCents, m.target_cents))} / {formatCents(m.target_cents)}
              </span>
            </div>
            <ProgressBar
              fraction={m.progress_bps / 10000}
              label={labels[m.key] ?? m.key}
              valueText={`${Math.round(m.progress_bps / 100)}% of ${formatCents(m.target_cents)}`}
              tone={m.reached ? "success" : "accent"}
            />
          </div>
        ))}
        <p className="sk-card__eyebrow">
          {fund.monthly_plan_cents
            ? `At ${formatCents(fund.monthly_plan_cents)} a month: ${
                starter?.reached
                  ? "starter fund done"
                  : `starter fund in ${starter?.eta_months === null || starter?.eta_months === undefined ? "–" : monthsText(starter.eta_months)}`
              }${
                target
                  ? `, ${fund.target_months}-month target ${target.reached ? "reached" : `in ${target.eta_months === null ? "–" : monthsText(target.eta_months)}`}`
                  : ""
              }. Raising your amount shortens this.`
            : "Set a monthly amount to see when you'd get there."}
        </p>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Essentials and plan">
        <p className="auth__hint">
          Essentials are what one month costs if income stopped: rent or mortgage, food, utilities,
          transport, insurance, minimum payments. The plan is what you'll add each month.
        </p>
        <label className="auth__field">
          <span className="auth__label">Monthly essentials</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder={essentialsCents > 0 ? (essentialsCents / 100).toFixed(2) : "3,062"}
            value={essentialsText}
            onChange={(e) => setEssentialsText(e.target.value)}
          />
        </label>
        <label className="auth__field">
          <span className="auth__label">Monthly amount you'll add</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder={
              fund.monthly_plan_cents ? (fund.monthly_plan_cents / 100).toFixed(2) : "154"
            }
            value={planText}
            onChange={(e) => setPlanText(e.target.value)}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={save}>
          Save
        </Button>
      </Sheet>
    </>
  );
}
