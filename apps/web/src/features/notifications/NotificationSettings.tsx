import "../auth/auth.css";
import "../entries/entries.css";
import "../groups/groups.css";

import { Button, Card, Toggle } from "@stackd/ui";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import type { NotificationSettingsOut } from "../../data/api.ts";
import { needsHomeScreen, type PushOutcome, unsubscribeFromPush } from "../../pwa/pushSubscribe.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { NotificationPrePrompt } from "./NotificationPrePrompt.tsx";
import {
  clockText,
  DAY_NAMES,
  DIGEST_TYPES,
  TYPE_COPY,
  useNotificationSettings,
} from "./useNotifications.ts";

const TYPE_ORDER = [
  "upcoming_expense",
  "shortfall_risk",
  "challenge_checkin",
  "goal_behind_pace",
  "milestone_reached",
  "group_activity",
  "weekly_recap",
];

/**
 * Me → Alerts (mockup F6Notify): push on this device; what you get and when, one switch per
 * type with its "when" choices under it while it is on (low balance, milestones and group
 * activity: as it happens or one daily summary); how often (quiet hours, the daily
 * maximum, pause all); and the always-on security alerts note.
 */
export function NotificationSettings() {
  const ids = useId();
  const { data, error, update, refresh } = useNotificationSettings();
  const [prePrompt, setPrePrompt] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  function outcomeNote(outcome: PushOutcome): string {
    switch (outcome) {
      case "subscribed":
        return "Notifications are on.";
      case "denied":
        return "Your browser blocked notifications. Allow them in its settings to turn these on.";
      case "needs_home_screen":
        return "On iPhone, add Qash to your Home Screen first (Me → Install Qash), then come back.";
      case "unavailable":
        return "Push isn't set up on the server yet.";
      default:
        return "This browser can't receive notifications.";
    }
  }

  if (!data) {
    return (
      <>
        <ScreenHeader title="Alerts" actions={null} back="/me" />
        {error ? (
          <Card>
            <p>Couldn't load your notification settings. Try again when online.</p>
          </Card>
        ) : (
          <p className="sr-only" role="status">
            Loading
          </p>
        )}
      </>
    );
  }
  const prefs = data.prefs as NotificationSettingsOut["prefs"];
  const s = data.settings;
  const paused = s.paused_until && new Date(s.paused_until) > new Date();

  /** As it happens, or held for one daily summary at a chosen time. */
  function deliveryFor(kind: string) {
    const p = prefs[kind];
    const daily = p?.delivery === "daily";
    return (
      <>
        <p className="auth__label">Send</p>
        <ChoiceChips
          name={`${ids}-${kind}-delivery`}
          options={[
            ["instant", "As it happens"],
            ["daily", "One daily summary"],
          ]}
          value={daily ? "daily" : "instant"}
          onPick={(v) => void update({ prefs: { [kind]: { delivery: v as "instant" | "daily" } } })}
        />
        {daily ? (
          <label className="auth__field">
            <span className="auth__label">Summary time</span>
            <input
              className="auth__input"
              type="time"
              defaultValue={p?.time_of_day ?? "19:00"}
              onBlur={(e) =>
                e.target.value &&
                void update({ prefs: { [kind]: { time_of_day: e.target.value } } })
              }
            />
          </label>
        ) : null}
      </>
    );
  }

  /** The "when" choices for a type that has them, shown under it while it is on. */
  function whenFor(kind: string) {
    if (DIGEST_TYPES.includes(kind)) return deliveryFor(kind);
    switch (kind) {
      case "upcoming_expense":
        return (
          <>
            <p className="auth__label">Days before</p>
            <ChoiceChips
              name={`${ids}-lead`}
              options={[
                ["1", "1 day"],
                ["3", "3 days"],
                ["7", "7 days"],
              ]}
              value={String(prefs.upcoming_expense?.lead_days ?? 3)}
              onPick={(v) => void update({ prefs: { upcoming_expense: { lead_days: Number(v) } } })}
            />
          </>
        );
      case "challenge_checkin":
        return (
          <>
            <label className="auth__field">
              <span className="auth__label">Reminder time</span>
              <input
                className="auth__input"
                type="time"
                defaultValue={prefs.challenge_checkin?.time_of_day ?? "19:30"}
                onBlur={(e) =>
                  e.target.value &&
                  void update({ prefs: { challenge_checkin: { time_of_day: e.target.value } } })
                }
              />
            </label>
          </>
        );
      case "goal_behind_pace":
        return (
          <>
            <p className="auth__label">Alert after</p>
            <ChoiceChips
              name={`${ids}-periods`}
              options={[
                ["1", "1 missed period"],
                ["2", "2 missed periods"],
              ]}
              value={String(prefs.goal_behind_pace?.threshold ?? 1)}
              onPick={(v) => void update({ prefs: { goal_behind_pace: { threshold: Number(v) } } })}
            />
          </>
        );
      case "weekly_recap":
        return (
          <>
            <p className="auth__label">Day</p>
            <ChoiceChips
              name={`${ids}-day`}
              options={DAY_NAMES.map((d, i) => [String(i), d])}
              value={String(Number((prefs.weekly_recap?.days ?? "0").split(",")[0]))}
              onPick={(v) => void update({ prefs: { weekly_recap: { days: v } } })}
            />
            <label className="auth__field">
              <span className="auth__label">Time</span>
              <input
                className="auth__input"
                type="time"
                defaultValue={prefs.weekly_recap?.time_of_day ?? "09:00"}
                onBlur={(e) =>
                  e.target.value &&
                  void update({ prefs: { weekly_recap: { time_of_day: e.target.value } } })
                }
              />
            </label>
            <p className="auth__label">Send as</p>
            <ChoiceChips
              name={`${ids}-channel`}
              options={[
                ["push", "Push"],
                ["email", "Email"],
                ["both", "Both"],
              ]}
              value={prefs.weekly_recap?.channel ?? "push"}
              onPick={(v) =>
                void update({
                  prefs: { weekly_recap: { channel: v as "push" | "email" | "both" } },
                })
              }
            />
            <p className="auth__hint">
              The email only says your recap is ready and links to it. Your numbers stay on this
              device.{" "}
              <Link to="/recap" className="auth__link">
                See this week's recap
              </Link>
            </p>
          </>
        );
      default:
        return null;
    }
  }

  return (
    <>
      <ScreenHeader title="Alerts" actions={null} back="/me" />
      <Card as="section" aria-label="Push" id="alerts-push">
        {data.push.subscribed ? (
          <>
            <p>
              <strong>Push is on</strong> for this browser.
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await unsubscribeFromPush();
                await refresh();
              }}
            >
              Turn off on this device
            </Button>
          </>
        ) : (
          <>
            <p>
              <strong>Push is off.</strong>{" "}
              {needsHomeScreen()
                ? "On iPhone, add Qash to your Home Screen first; then push works."
                : "Turn it on to get these on this device."}
            </p>
            <Button size="sm" onClick={() => setPrePrompt(true)} disabled={!data.push.available}>
              Turn on notifications
            </Button>
            {!data.push.available ? (
              <p className="auth__hint">Push isn't set up on the server yet.</p>
            ) : null}
          </>
        )}
        {note ? (
          <p className="auth__hint" role="status">
            {note}
          </p>
        ) : null}
      </Card>
      <section aria-labelledby="what-h">
        <h2 className="section-title" id="what-h">
          What you get and when
        </h2>
        <ul className="sk-list sk-list--card" aria-label="Alert types">
          {TYPE_ORDER.map((kind) => {
            const p = prefs[kind] ?? { enabled: false };
            const copy = TYPE_COPY[kind];
            if (!copy) return null;
            const when = p.enabled ? whenFor(kind) : null;
            return (
              <li key={kind} className="sk-list__item alert-type" id={`alerts-${kind}`}>
                <div className="sk-row">
                  <span className="sk-row__text">
                    <span className="sk-row__label">{copy.title}</span>
                    <span className="sk-row__sublabel">{p.enabled ? copy.sub(p) : "Off"}</span>
                  </span>
                  <span className="sk-row__value">
                    <Toggle
                      label={`${copy.title} alerts`}
                      checked={p.enabled}
                      onChange={(checked) =>
                        void update({ prefs: { [kind]: { enabled: checked } } })
                      }
                    />
                  </span>
                </div>
                {when ? (
                  <fieldset className="alert-type__when">
                    <legend className="sr-only">{`${copy.title} options`}</legend>
                    {when}
                  </fieldset>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-labelledby="often-h" id="alerts-often">
        <h2 className="section-title" id="often-h">
          How often
        </h2>
        <Card as="section" aria-label="Quiet hours and limits">
          <div className="hero-split">
            <span className="receipt-card__title">Quiet hours</span>
            <span>
              {clockText(s.quiet_start)} – {clockText(s.quiet_end)}
            </span>
          </div>
          <div className="suggestion__actions">
            <label className="auth__field">
              <span className="auth__label">From</span>
              <input
                className="auth__input"
                type="time"
                aria-label="Quiet from"
                defaultValue={s.quiet_start}
                onBlur={(e) =>
                  e.target.value && void update({ settings: { quiet_start: e.target.value } })
                }
              />
            </label>
            <label className="auth__field">
              <span className="auth__label">Until</span>
              <input
                className="auth__input"
                type="time"
                aria-label="Quiet until"
                defaultValue={s.quiet_end}
                onBlur={(e) =>
                  e.target.value && void update({ settings: { quiet_end: e.target.value } })
                }
              />
            </label>
          </div>
          <div className="hero-split">
            <span className="receipt-card__title">Most per day</span>
            <span>
              {s.daily_max === 0 ? "No limit" : `${s.daily_max} · extras go in one summary`}
            </span>
          </div>
          <ChoiceChips
            name={`${ids}-max`}
            options={[
              ["1", "1"],
              ["3", "3"],
              ["5", "5"],
              ["0", "No limit"],
            ]}
            value={String(s.daily_max)}
            onPick={(v) => void update({ settings: { daily_max: Number(v) } })}
          />
          <div className="hero-split">
            <span className="receipt-card__title">Pause all</span>
            <span>
              {paused
                ? `Paused until ${new Date(s.paused_until as string).toLocaleDateString()}`
                : "Not paused"}
            </span>
          </div>
          <div className="install-actions">
            {paused ? (
              <Button
                variant="secondary"
                onClick={() => void update({ settings: { pause: "none" } })}
              >
                Resume
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => void update({ settings: { pause: "day" } })}
                >
                  1 day
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void update({ settings: { pause: "week" } })}
                >
                  1 week
                </Button>
              </>
            )}
          </div>
        </Card>
      </section>
      <Card as="section" aria-label="Security alerts">
        <p className="receipt-card__title">Security alerts are always on</p>
        <p className="group-row__meta">
          New sign-ins, passkey changes, exports, email changes and deletion requests, sent by
          email, and push if allowed.
        </p>
      </Card>
      <p className="auth__fineprint">
        Alerts never include amounts or merchant names. Open the app to see details.
      </p>
      <NotificationPrePrompt
        open={prePrompt}
        onClose={() => setPrePrompt(false)}
        onDone={async (outcome) => {
          setPrePrompt(false);
          setNote(outcomeNote(outcome));
          await refresh();
        }}
      />
    </>
  );
}
