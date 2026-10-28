import "./groups.css";
import "../entries/entries.css";
import "../auth/auth.css";

import { Button, Card } from "@stackd/ui";
import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { customJar, EngineError, monthBounds, parseAmount } from "../../engine/bridge.ts";
import { formatMonth, todayIso } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { TARGET_PRESETS, TargetField } from "./TargetField.tsx";
import { nextSaturday, TEMPLATES, type TemplateKey, templateOf } from "./templates.ts";
import { createGroup, isFailure, setDisplayName } from "./useGroups.ts";

/**
 * Start a monthly savings challenge (docs/spec.md "Groups"): a name, your own target for the
 * month (kept on this device) and, the first time, the name other members will see.
 */
export function CreateGroup() {
  const { db } = useDb();
  const navigate = useNavigate();
  const session = useSession();
  const ids = useId();
  const today = todayIso();
  const month = today.slice(0, 7);
  const [templateKey, setTemplateKey] = useState<TemplateKey>("monthly_savings");
  const template = templateOf(templateKey);
  const [name, setName] = useState(`${formatMonth(today).split(" ")[0]} savings challenge`);
  const [startDate, setStartDate] = useState(today);
  const [target, setTarget] = useState<number>(TARGET_PRESETS[2] as number);
  const [custom, setCustom] = useState("");
  const [baselineText, setBaselineText] = useState("");

  function pickTemplate(key: TemplateKey) {
    const t = templateOf(key);
    setTemplateKey(key);
    setName(
      key === "monthly_savings" ? `${formatMonth(today).split(" ")[0]} savings challenge` : t.title,
    );
    setStartDate(key === "no_spend_weekend" ? nextSaturday(today) : today);
    setTarget((t.targetPresets[0] ?? TARGET_PRESETS[2]) as number);
    setCustom("");
  }
  const [displayName, setDisplayNameText] = useState(session.info?.user?.display_name ?? "");
  const needsName = !session.info?.user?.display_name;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { entitlements } = useEntitlements();
  const canCreate = entitlements.groups_create;

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const money = template.kind !== "habit";
      const cents = money ? (custom.trim() ? await parseAmount(custom) : target) : null;
      const bounds = await monthBounds(today);
      if (!name.trim()) {
        setError("Give the challenge a name.");
        return;
      }
      if (money && cents !== null)
        await customJar("Target", cents, template.span === "month" ? bounds.end : null, today); // the amount check of a jar
      let baseline: number | null = null;
      if (template.kind === "spend_less") {
        if (!baselineText.trim()) {
          setError("Tell us what you usually spend on dining in a month.");
          return;
        }
        baseline = await parseAmount(baselineText);
      }
      if (needsName) {
        const trimmed = displayName.trim();
        if (!trimmed) {
          setError("Add the name members will see.");
          return;
        }
        const failure = await setDisplayName(trimmed);
        if (failure) {
          setError("Couldn't save your name. Try again.");
          return;
        }
        await session.refresh();
      }
      const result = await createGroup(db, {
        name: name.trim(),
        templateKey,
        month: template.span === "month" ? month : undefined,
        startDate: template.span === "month" ? undefined : startDate,
        targetCents: cents,
        baselineCents: baseline,
      });
      if (isFailure(result)) {
        setError(
          result.code === "plan_required"
            ? "Starting a challenge needs Private or Connected. Joining one is on every plan."
            : result.status === 0
              ? "You're offline. Try again when connected."
              : "Couldn't start it.",
        );
        return;
      }
      navigate(`/groups/${result.id}`, { replace: true });
    } catch (err) {
      const code = err instanceof EngineError ? err.code : "";
      setError(code === "deadline_in_past" ? "This month is over." : "Enter a target like 300.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ScreenHeader title="Start a challenge" actions={null} back="/goals" />
      <fieldset className="kind-chips" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="sr-only">Challenge type</legend>
        {TEMPLATES.map((t) => (
          <label className="chip-option" key={t.key}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-template`}
              value={t.key}
              checked={templateKey === t.key}
              onChange={() => pickTemplate(t.key)}
            />
            {t.title}
          </label>
        ))}
      </fieldset>
      <Card>
        <p>
          {template.span === "month"
            ? `Until the end of ${formatMonth(today)}.`
            : template.span === "week"
              ? "Seven days from the start."
              : template.span === "weekend"
                ? "One Saturday and Sunday."
                : "52 weeks from the start."}{" "}
          Others see your name and %, never amounts.
        </p>
      </Card>
      {template.span !== "month" ? (
        <label className="auth__field">
          <span className="auth__label">Start date</span>
          <input
            className="auth__input"
            type="date"
            value={startDate}
            min={today}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
      ) : null}
      <label className="auth__field">
        <span className="auth__label">Challenge name</span>
        <input
          className="auth__input"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {template.kind === "spend_less" ? (
        <label className="auth__field">
          <span className="auth__label">What you usually spend on dining in a month</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="380"
            value={baselineText}
            onChange={(e) => setBaselineText(e.target.value)}
          />
        </label>
      ) : null}
      {template.kind !== "habit" ? (
        <TargetField
          name={`${ids}-target`}
          value={target}
          onPick={setTarget}
          custom={custom}
          onCustom={setCustom}
          presets={template.targetPresets}
          weeklyStep={template.span === "year"}
          label={
            template.kind === "spend_less"
              ? "How much to keep back"
              : template.span === "year"
                ? "Your total over 52 weeks"
                : "Your target this month"
          }
        />
      ) : null}
      {needsName ? (
        <label className="auth__field">
          <span className="auth__label">Your name, as members will see it</span>
          <input
            className="auth__input"
            value={displayName}
            maxLength={40}
            placeholder="e.g. Maya R."
            onChange={(e) => setDisplayNameText(e.target.value)}
          />
        </label>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {!canCreate ? (
        <PlanLimit>
          Starting a challenge needs Private or Connected. Joining one with a code is on every plan.
        </PlanLimit>
      ) : null}
      <Button block onClick={start} disabled={busy || !canCreate}>
        Start challenge
      </Button>
      <p className="auth__fineprint">
        You'll get an invite code to share. Logging money here never moves it.
      </p>
    </>
  );
}
