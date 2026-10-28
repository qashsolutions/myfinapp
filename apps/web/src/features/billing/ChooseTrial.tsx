import "../auth/auth.css";
import "./billing.css";

import { Button } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { formatCents } from "../../lib/format.ts";
import { AuthLayout } from "../auth/AuthLayout.tsx";
import { priceCents, useBilling } from "./billing.ts";
import { useEntitlements } from "./entitlements.ts";

type TrialPlan = "private" | "connected";

const CHOICES: Array<{
  plan: TrialPlan;
  name: string;
  value: string;
  points: Array<[Icon, string]>;
}> = [
  {
    plan: "private",
    name: "Private",
    value: "Every account. Never linked. Fully private.",
    points: [
      ["file", "Statements read on your device"],
      ["jar", "4 jars & goals"],
      ["cloud", "Encrypted backup & sync"],
    ],
  },
  {
    plan: "connected",
    name: "Connected",
    value: "Banks and cards update themselves.",
    points: [
      ["link", "Link 3 banks or cards, read-only"],
      ["jar", "10 jars & goals"],
      ["heart", "Couples & shared jars"],
    ],
  },
];

/**
 * Pick a free trial (owner decision, October 14, 2026): no lasting Free plan. Shown once, right
 * after sign-up, until a trial is picked: a 3-day free trial of Private or Connected, no
 * card. The lengths and prices come from the server (plans.yaml).
 */
export function ChooseTrial() {
  const navigate = useNavigate();
  const { billing } = useBilling();
  const { refresh } = useEntitlements();
  const [picked, setPicked] = useState<TrialPlan>("private");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    document.title = `Start your free trial · ${APP_NAME}`;
  }, []);
  const days = (plan: TrialPlan): number | null => {
    const d = billing?.trials?.[plan];
    return typeof d === "number" ? d : null;
  };

  async function start() {
    setBusy(true);
    setNote(null);
    const r = await api.POST("/api/billing/trial", { body: { plan: picked } });
    const failure = failureOf(r);
    if (failure) {
      setBusy(false);
      setNote(
        failure.code === "trial_used"
          ? "This email has already had its free trial. Choose a plan to continue."
          : failure.status === 0
            ? "You're offline. Try again when connected."
            : "Couldn't start the trial. Try again.",
      );
      if (failure.code === "trial_used") navigate("/me/plan");
      return;
    }
    await refresh();
    // Then "Make Qash yours": choices, not a wizard (owner, October 20, 2026).
    navigate("/setup", { replace: true });
  }

  return (
    <AuthLayout brand>
      <h1 className="auth__title trial__title">Try {APP_NAME} free</h1>
      <p className="auth__lead">No card needed. Pick one to start.</p>
      <fieldset className="trial__choices">
        <legend className="sr-only">Free trial</legend>
        {CHOICES.map((c) => {
          const on = picked === c.plan;
          const after = billing ? priceCents(billing, c.plan, "yearly") : 0;
          return (
            <label
              key={c.plan}
              className={`trial__card trial__card--${c.plan}${on ? " is-on" : ""}`}
            >
              <input
                type="radio"
                name="trial"
                className="sr-only"
                value={c.plan}
                checked={on}
                onChange={() => setPicked(c.plan)}
              />
              <span className="trial__head">
                <span className="trial__mark" aria-hidden="true">
                  <TrialIcon kind={c.plan === "private" ? "shield" : "link"} />
                </span>
                <span className="trial__name">{c.name}</span>
                {days(c.plan) ? (
                  <span className="trial__days">Free for {days(c.plan)} days</span>
                ) : null}
              </span>
              <span className="trial__value">{c.value}</span>
              <span className="trial__points">
                {c.points.map(([icon, t]) => (
                  <span key={t} className="trial__point">
                    <span className="trial__picon" aria-hidden="true">
                      <TrialIcon kind={icon} />
                    </span>
                    {t}
                  </span>
                ))}
              </span>
              {after ? (
                <span className="trial__after">
                  Then {formatCents(Math.round(after / 12))} a month, billed yearly
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>
      {note ? (
        <p className="auth__note" role="alert">
          {note}
        </p>
      ) : null}
      <div className="auth__spacer" />
      <div className="auth__actions">
        <Button block onClick={() => void start()} disabled={busy || !billing}>
          {days(picked) ? `Start my ${days(picked)}-day free trial` : "Start my free trial"}
        </Button>
      </div>
      {/* How the trial works, up front and in full (owner, October 20, 2026: transparent,
          upfront and honest). Matches plans.yaml trials and jobs/plan_lifecycle.py. */}
      <ul className="trial__how" aria-label="How the free trial works">
        <li>No card needed, and nothing is charged during the trial.</li>
        <li>We send a friendly reminder the day before it ends.</li>
        <li>
          If you don't continue, you have 7 days to pick a plan or download your data, with a short
          note each day.
        </li>
        <li>
          Then we close your account and remove what we kept. What's on your device stays there
          until you decide.
        </li>
      </ul>
    </AuthLayout>
  );
}

type Icon = "file" | "jar" | "cloud" | "link" | "heart" | "shield";

function TrialIcon({ kind }: { kind: Icon }) {
  const d: Record<Icon, string> = {
    file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4",
    jar: "M7 3h10v3H7zM6 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM6 13h12",
    cloud:
      "M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5zM10 12h4v3.5h-4zM10.8 12v-1a1.2 1.2 0 0 1 2.4 0v1",
    link: "M3 9.5 12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18",
    heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 11h6v5H9zM10 11V9.5a2 2 0 0 1 4 0V11",
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={d[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
