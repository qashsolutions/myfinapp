import "../auth/auth.css";
import "../entries/entries.css";
import "../groups/groups.css";
import "../pwa/pwa.css";
import "../receipts/receipts.css";
import "./subscriptions.css";

import { Button, Card, Illustration, ProgressBar, Sheet } from "@stackd/ui";
import { useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { RecurringSeries } from "../../data/db.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { INTERVAL_LABELS, removeSeries } from "../forecast/useRecurring.ts";
import { setSubscription, useSubscriptions } from "./useSubscriptions.ts";

function renewsText(days: number, date: string): string {
  if (days <= 0) return `Renews today, ${formatDay(date)}`;
  if (days === 1) return `Renews tomorrow, ${formatDay(date)}`;
  return `Renews in ${days} days, ${formatDay(date)}`;
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
  const top = view?.subscriptions[0]?.yearly_cents ?? 0;

  return (
    <>
      <ScreenHeader title="Subscriptions" back="/bills" actions={null} />
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
          <Word>Yearly</Word>
          <p className="subs__hero">{formatCents(view.totals.yearly_cents)} a year</p>
          <p className="sk-card__eyebrow">
            {formatCents(view.totals.monthly_cents)} a month across {view.subscriptions.length}{" "}
            {view.subscriptions.length === 1 ? "subscription" : "subscriptions"}
          </p>
        </Card>
      )}
      {done ? (
        <p className="auth__hint" role="status">
          {done}
        </p>
      ) : null}
      {view?.subscriptions.length ? (
        <section aria-labelledby="subs-list">
          <h2 className="section-title" id="subs-list">
            Each one, by what it costs a year
          </h2>
          {view.subscriptions.map(({ series, yearly_cents, monthly_cents, days }) => (
            <Card as="section" aria-label={series.label} key={series.id} className="subs__item">
              <div className="hero-split">
                <span className="receipt-card__title">{series.label}</span>
                <span className="lb__pct">{formatCents(yearly_cents)} a year</span>
              </div>
              <ProgressBar
                fraction={top > 0 ? yearly_cents / top : 0}
                label={`${series.label}, a year`}
                valueText={`${formatCents(yearly_cents)} a year`}
              />
              <p className="sk-card__eyebrow">
                {formatCents(series.expected_cents)}{" "}
                {INTERVAL_LABELS[series.interval].toLowerCase()} · {formatCents(monthly_cents)} a
                month · {renewsText(days, series.next_date)}
              </p>
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
