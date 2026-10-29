import "../auth/auth.css";
import "../entries/entries.css";
import "../groups/groups.css";
import "../pwa/pwa.css";
import "../receipts/receipts.css";
import "./subscriptions.css";

import { Button, Card, Chip, Illustration, ProgressBar, Sheet } from "@stackd/ui";
import { useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { RecurringSeries } from "../../data/db.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { INTERVAL_LABELS, removeSeries } from "../forecast/useRecurring.ts";
import { KindBar, KindLegend } from "./KindBar.tsx";
import { kindLabel, useCheckIntervals } from "./kinds.ts";
import { SubscriptionCheckCard } from "./SubscriptionCheckCard.tsx";
import { AdjustCheckSheet, KindSheet } from "./SubscriptionSheets.tsx";
import { keepSubscription, setSubscription, useSubscriptions } from "./useSubscriptions.ts";

function countdown(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

/**
 * Subscriptions (owner decision, October 27, 2026): every confirmed bill counted as a
 * subscription with what it costs a year (`recurring.yearly_cost`), when it renews, and how to
 * cancel it. Nothing is cancelled for the person; "I cancelled it" only stops the forecast
 * counting it. Renewal reminders are the Bill due soon alert.
 */
export function SubscriptionsScreen() {
  const { db } = useDb();
  const today = todayIso();
  const view = useSubscriptions(today);
  const [cancelling, setCancelling] = useState<RecurringSeries | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [kindFor, setKindFor] = useState<{ series: RecurringSeries; kind: string | null } | null>(
    null,
  );
  const intervals = useCheckIntervals();
  const top = Math.max(0, ...(view?.subscriptions.map((s) => s.monthly_cents) ?? [0]));

  return (
    <>
      <ScreenHeader
        title="Subscriptions"
        back="/bills"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdjusting(true)}>
            Adjust
          </Button>
        }
      />
      {!view ? (
        <p className="auth__hint">Adding it up…</p>
      ) : view.subscriptions.length === 0 ? (
        <Card>
          <Illustration name="card" tone="a2" />
          <Word>None</Word>
          <p>
            No subscriptions yet. Confirm the bills Qash finds in your statements, or count one of
            your bills below.
          </p>
        </Card>
      ) : (
        <Card as="section" aria-label="A year of subscriptions">
          <p className="sk-card__hero">
            {formatCents(view.totals.yearly_cents)}
            <span className="sk-card__hero-unit"> a year</span>
          </p>
          <p className="sk-card__eyebrow">
            {view.subscriptions.length}{" "}
            {view.subscriptions.length === 1 ? "subscription" : "subscriptions"} ·{" "}
            {formatCents(view.totals.monthly_cents)} a month
          </p>
          <KindBar rows={view.check.by_kind} />
          <KindLegend rows={view.check.by_kind} />
        </Card>
      )}
      {view && view.subscriptions.length > 0 ? (
        <SubscriptionCheckCard
          view={view}
          onKeep={async (series) => {
            await keepSubscription(db, series.id, today);
            setDone(
              `Kept ${series.label}. Qash will ask again in ${intervals?.askDays ?? "a few"} days.`,
            );
          }}
          onCancelled={async (series) => {
            await removeSeries(db, series.id);
            setDone(`${series.label} is off your bills. Your past entries stay.`);
          }}
          onHowTo={setCancelling}
        />
      ) : null}
      {done ? (
        <p className="auth__hint" role="status">
          {done}
        </p>
      ) : null}
      {view?.subscriptions.length ? (
        <section aria-labelledby="subs-list">
          <h2 className="section-title" id="subs-list">
            Each one, by what it costs
          </h2>
          {view.subscriptions.map(({ series, yearly_cents, monthly_cents, days, kind }) => (
            <Card as="section" aria-label={series.label} key={series.id} className="subs__item">
              <div className="hero-split">
                <span className="receipt-card__title">{series.label}</span>
                <Chip tone={days <= 7 ? "accent" : "neutral"}>{countdown(days)}</Chip>
              </div>
              <button
                type="button"
                className="subs__kind"
                aria-label={`Kind: ${kindLabel(kind)}. Change the kind of ${series.label}`}
                onClick={() => setKindFor({ series, kind })}
              >
                {kindLabel(kind)}
                {series.subscription_kind ? " · yours" : ""} ▾
              </button>
              <ProgressBar
                fraction={top > 0 ? monthly_cents / top : 0}
                tone="accent"
                label={`${series.label}, a month`}
                valueText={`${formatCents(monthly_cents)} a month`}
              />
              <p className="subs__amounts">
                <strong>{formatCents(monthly_cents)}</strong> a month · {formatCents(yearly_cents)}{" "}
                a year
              </p>
              <p className="sk-card__eyebrow">Renews {formatDay(series.next_date)}</p>
              <div className="install-actions">
                <Button size="sm" variant="secondary" onClick={() => setCancelling(series)}>
                  How to cancel
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void setSubscription(db, series.id, false)}
                >
                  Not a subscription
                </Button>
              </div>
            </Card>
          ))}
          <p className="auth__hint">
            Reminders before each renewal come from{" "}
            <Link to="/me/notifications" className="auth__link">
              Bill due soon alerts
            </Link>
            , at the days and time you choose.
          </p>
        </section>
      ) : null}
      {view?.others.length ? (
        <section aria-labelledby="subs-others">
          <h2 className="section-title" id="subs-others">
            Your other bills
          </h2>
          <Card>
            {view.others.map((s) => (
              <div className="hero-split subs__other" key={s.id}>
                <span>
                  {s.label} · {formatCents(s.expected_cents)}{" "}
                  {INTERVAL_LABELS[s.interval].toLowerCase()}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Count ${s.label} as a subscription`}
                  onClick={() => void setSubscription(db, s.id, true)}
                >
                  It's a subscription
                </Button>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
      <p className="auth__fineprint">
        Yearly costs are each charge times how often it comes. Qash never cancels anything for you.
      </p>

      {intervals ? (
        <AdjustCheckSheet
          open={adjusting}
          onClose={() => setAdjusting(false)}
          intervals={intervals}
        />
      ) : null}
      <KindSheet
        series={kindFor?.series ?? null}
        kind={kindFor?.kind ?? null}
        onClose={() => setKindFor(null)}
      />
      <Sheet
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={cancelling ? `Cancel ${cancelling.label}` : "Cancel"}
      >
        <ol className="subs__steps">
          <li>Open {cancelling?.label ?? "the service"}'s own website or app and sign in.</li>
          <li>Look under Account, Billing, Membership or Subscription for Cancel.</li>
          <li>
            Paying through your phone? On iPhone: Settings → your name → Subscriptions. On Android:
            Google Play → your profile → Payments & subscriptions → Subscriptions.
          </li>
          <li>Keep the confirmation email until the last charge has passed.</li>
        </ol>
        <p className="auth__hint">
          Once it's cancelled, tell Qash so your forecast and alerts stop counting it.
        </p>
        <Button
          block
          onClick={async () => {
            if (!cancelling) return;
            await removeSeries(db, cancelling.id);
            setDone(`${cancelling.label} is off your bills. Your past entries stay.`);
            setCancelling(null);
          }}
        >
          I cancelled it
        </Button>
      </Sheet>
    </>
  );
}
