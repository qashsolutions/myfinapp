import { Button, Card } from "@stackd/ui";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import type { RecurringSeries } from "../../data/db.ts";
import type { SubscriptionCheckItem } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { KindBar, YearShareBar } from "./KindBar.tsx";
import { kindMany } from "./kinds.ts";
import { type SubscriptionsView, useSubscriptions } from "./useSubscriptions.ts";

/** The question asked next: the costliest subscription the check says to ask about. */
export function nextQuestion(view: SubscriptionsView): SubscriptionCheckItem | null {
  return view.check.items.find((i) => i.ask) ?? null;
}

export function questionText(item: SubscriptionCheckItem): string {
  return `Still using ${item.label}? ${formatCents(item.yearly_cents)} a year`;
}

/** Facts from the person's own charges, one short line each (never a guess about use). */
export function checkFacts(view: SubscriptionsView): Array<{ key: string; text: string }> {
  const facts: Array<{ key: string; text: string }> = [];
  for (const i of view.check.items) {
    if (i.price_rise)
      facts.push({
        key: `rise-${i.id}`,
        text: `${i.label} went from ${formatCents(i.price_rise.from_cents)} to ${formatCents(i.price_rise.to_cents)}`,
      });
    if (i.trial_turned_charge) {
      const t = i.trial_turned_charge;
      const what = t.trial_cents === 0 ? "free trial" : `${formatCents(t.trial_cents)} trial`;
      facts.push({
        key: `trial-${i.id}`,
        text: `${i.label}: ${what} became ${formatCents(t.cents)} on ${formatDay(t.date)}`,
      });
    }
  }
  for (const d of view.check.duplicates)
    facts.push({
      key: `kind-${d.kind}`,
      text: `${d.count} ${kindMany(d.kind)} · ${formatCents(d.monthly_total_cents)} a month together`,
    });
  for (const i of view.check.items)
    if (i.renewal)
      facts.push({
        key: `renew-${i.id}`,
        text: `${i.label} renews ${formatDay(i.renewal.date)} · ${formatCents(i.renewal.cents)}`,
      });
  return facts;
}

/**
 * The Check card at the top of Subscriptions (October 28, 2026): one question at a time and the
 * facts from the charges. Qash cannot see whether a service is used, so it asks; "Keep it" stamps
 * the answer, "I cancelled it" removes the bill, "How to cancel" opens the steps.
 */
export function SubscriptionCheckCard({
  view,
  onKeep,
  onCancelled,
  onHowTo,
}: {
  view: SubscriptionsView;
  onKeep: (series: RecurringSeries) => void;
  onCancelled: (series: RecurringSeries) => void;
  onHowTo: (series: RecurringSeries) => void;
}) {
  const question = nextQuestion(view);
  const facts = checkFacts(view);
  const series = question
    ? view.subscriptions.find((s) => s.series.id === question.id)?.series
    : undefined;
  return (
    <Card as="section" aria-label="Subscription check" className="subs__check">
      <Word>{question || facts.length ? "Check" : "All good"}</Word>
      {question && series ? (
        <>
          <p className="subs__question">{questionText(question)}</p>
          <YearShareBar
            label={question.label}
            yearlyCents={question.yearly_cents}
            totalYearlyCents={view.totals.yearly_cents}
          />
          <div className="install-actions">
            <Button size="sm" onClick={() => onKeep(series)}>
              Keep it
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onCancelled(series)}>
              I cancelled it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onHowTo(series)}>
              How to cancel
            </Button>
          </div>
        </>
      ) : (
        <p>Nothing to look at right now.</p>
      )}
      {facts.length ? (
        <ul className="subs__facts" aria-label="From your charges">
          {facts.map((f) => (
            <li key={f.key}>{f.text}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** Home's small card (HOME_CARDS "sub_check"): shown only while there is something to ask. */
export function SubCheckHomeCard({ today }: { today: string }) {
  const view = useSubscriptions(today);
  const question = view ? nextQuestion(view) : null;
  if (!question) return null;
  return (
    <Link
      to="/subscriptions"
      className="card-link"
      aria-label={`Subscription check: ${questionText(question)}, open Subscriptions`}
    >
      <Card as="div">
        <h2 className="sk-card__title">Subscriptions</h2>
        <KindBar rows={view?.check.by_kind ?? []} height={8} />
        <Word>Check</Word>
        <p className="subs__question">{questionText(question)}</p>
      </Card>
    </Link>
  );
}
