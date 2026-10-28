import "../auth/auth.css";
import "./billing.css";

import { Button, buttonClass } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { formatCents } from "../../lib/format.ts";
import { AuthLayout } from "../auth/AuthLayout.tsx";
import { BringBackOffer } from "../settings/KeptOnPhone.tsx";
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
  const { entitlements, refresh } = useEntitlements();
  const [picked, setPicked] = useState<TrialPlan>("private");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Signing up again with an inbox that already had its trial: the server says so up front,
  // or answers trial_used if it was claimed elsewhere since (October 28, 2026).
  const [usedHere, setUsedHere] = useState(false);
  const used = usedHere || entitlements.access?.trial_used === true;
  useEffect(() => {
    document.title = used ? `Welcome back · ${APP_NAME}` : `Start your free trial · ${APP_NAME}`;
  }, [used]);
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
      if (failure.code === "trial_used") {
        // The plans are open to this account; re-read so the gate lets it through to them.
        setUsedHere(true);
        await refresh();
        return;
      }
      setNote(
        failure.status === 0
          ? "You're offline. Try again when connected."
          : "Couldn't start the trial. Try again.",
      );
      return;
    }
    await refresh();
    // Then "Make Qash yours": choices, not a wizard (owner, October 20, 2026).
    navigate("/setup", { replace: true });
  }

  if (used) return <WelcomeBack />;

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
      <p className="auth__hint">
        Changed your mind? You can <Link to="/me/delete">delete your account</Link>.
      </p>
    </AuthLayout>
  );
}

/**
 * Someone signing up again with an email whose free trial was already used: no trial to start,
 * so say it plainly and lead to the plans; download and delete stay open too. A plan that
 * ended may have left data on this device, and BringBackOffer offers it here, before any purchase.
 */
function WelcomeBack() {
  return (
    <AuthLayout brand>
      <h1 className="auth__title trial__title">Welcome back</h1>
      <p className="auth__lead">
        Your free trial was already used on this email, so there isn't another one. Pick a plan to
        keep going with {APP_NAME}.
      </p>
      <div className="auth__spacer" />
      <div className="auth__actions">
        <Link className={buttonClass({ block: true })} to="/me/plan">
          See plans
        </Link>
        <Link className={buttonClass({ variant: "secondary", block: true })} to="/me/data">
          Download my data
        </Link>
      </div>
      <p className="auth__hint">
        Rather not continue? You can <Link to="/me/delete">delete your account</Link> any time.
      </p>
      <BringBackOffer />
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
