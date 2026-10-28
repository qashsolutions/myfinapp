import "./groups.css";
import "../entries/entries.css";
import "../auth/auth.css";

import { Button, Card, Chip } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import type { GroupPreview } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { customJar, EngineError, parseAmount } from "../../engine/bridge.ts";
import { formatDay, todayIso } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { TARGET_PRESETS, TargetField } from "./TargetField.tsx";
import { templateOf } from "./templates.ts";
import { isFailure, joinGroup, lookupGroup, setDisplayName } from "./useGroups.ts";

const CODE = /^STK-[A-Z0-9]{4}$/;

function normaliseCode(text: string): string {
  const raw = text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^STK/, "");
  return raw ? `STK-${raw.slice(0, 4)}` : "";
}

/** Join a group by invite code or share link (mockup F4Join). */
export function JoinGroup() {
  const { db } = useDb();
  const navigate = useNavigate();
  const session = useSession();
  const ids = useId();
  const [params] = useSearchParams();
  const today = todayIso();
  const [code, setCode] = useState(normaliseCode(params.get("code") ?? ""));
  const [preview, setPreview] = useState<GroupPreview | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [target, setTarget] = useState<number>(TARGET_PRESETS[1] as number);
  const [custom, setCustom] = useState("");
  const [baselineText, setBaselineText] = useState("");
  const template = templateOf(preview?.template_key);
  const [displayName, setDisplayNameText] = useState(session.info?.user?.display_name ?? "");
  const needsName = !session.info?.user?.display_name;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setLookupError(null);
    if (!CODE.test(code)) return;
    void lookupGroup(code).then((result) => {
      if (!alive) return;
      if (isFailure(result)) {
        setLookupError(
          result.status === 404
            ? "No group with that code. Check it and try again."
            : result.status === 429
              ? "Too many tries. Wait a few minutes."
              : "Couldn't look that up. Are you online?",
        );
      } else setPreview(result);
    });
    return () => {
      alive = false;
    };
  }, [code]);

  async function join() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const money = template.kind !== "habit";
      const cents = money ? (custom.trim() ? await parseAmount(custom) : target) : null;
      if (money && cents !== null) await customJar("Target", cents, null, today); // the amount check of a jar
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
      const result = await joinGroup(db, { code, targetCents: cents, baselineCents: baseline });
      if (isFailure(result)) {
        setError(
          result.code === "plan_limit"
            ? "Your plan joins one challenge at a time. Leave the other first, or choose a bigger plan."
            : result.status === 404
              ? "That code no longer works."
              : "Couldn't join. Try again.",
        );
        return;
      }
      navigate(`/groups/${result.id}`, { replace: true });
    } catch (err) {
      const code = err instanceof EngineError ? err.code : "";
      setError(
        code === "deadline_in_past"
          ? "This challenge has already ended."
          : "Enter a target like 300.",
      );
    } finally {
      setBusy(false);
    }
  }

  const shownName = displayName.trim() || session.info?.user?.display_name || "you";

  return (
    <>
      <ScreenHeader title="Join a group" actions={null} back="/goals" />
      <label className="auth__field">
        <span className="auth__label">Invite code</span>
        <input
          className="auth__input code-input"
          value={code}
          placeholder="STK-XXXX"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={8}
          onChange={(e) => setCode(normaliseCode(e.target.value))}
        />
      </label>
      {lookupError ? (
        <p className="auth__error" role="alert">
          {lookupError}
        </p>
      ) : null}
      {preview ? (
        <Card as="section" aria-label="Group">
          <div className="goal-card__top">
            <span className="goal-card__title">{preview.name}</span>
            <Chip tone="accent">
              {preview.member_count} {preview.member_count === 1 ? "member" : "members"}
            </Chip>
          </div>
          <p className="group-row__meta">
            Started by {preview.started_by} · {formatDay(preview.start_date)} –{" "}
            {formatDay(preview.end_date)}
          </p>
          <p className="sk-card__eyebrow">{template.title}</p>
          <ul className="auth__points">
            {template.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {preview.already_member ? (
            <Link to={`/groups/${preview.id}`} className="auth__link">
              You're already in this group. Open it.
            </Link>
          ) : null}
        </Card>
      ) : null}
      <Card as="section" aria-label="What the group sees">
        <h2 className="sk-card__title">What the group sees</h2>
        <p>
          Your display name and % progress. Never your amounts, accounts or transactions; those stay
          on your device.
        </p>
      </Card>
      {preview && !preview.already_member ? (
        <>
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
          <Button block onClick={join} disabled={busy}>
            Join as "{shownName}"
          </Button>
        </>
      ) : null}
    </>
  );
}
