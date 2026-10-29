import { Button, buttonClass, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link } from "react-router";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { PayFrequency, PaySettings } from "../../data/db.ts";
import { monthlyTakeHome } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import {
  confirmSuggestion,
  dismissSuggestion,
  inConfirmAll,
  suggestionInterval,
  useRecurringSuggestions,
} from "../forecast/useRecurring.ts";

const PAY_FREQUENCY: Record<string, PayFrequency | undefined> = {
  weekly: "weekly",
  biweekly: "biweekly",
  semimonthly: "semimonthly",
  monthly: "monthly",
};

/**
 * "Found in your statements" (October 19, 2026): what the recurring rule spotted after an import,
 * as three counts and the next few bills, confirmable in one tap. A paycheck found on a regular
 * schedule can become Budget's pay in one tap too, so the forecast and the set-aside target
 * sharpen without a form. Shown only while there's something to confirm.
 */
export function FoundCard({ asOf }: { asOf: string }) {
  const { db } = useDb();
  const suggestions = useRecurringSuggestions(asOf);
  const pay = useLiveQuery(
    async () => (await db.settings.get("pay"))?.value as PaySettings | undefined,
    [db],
  );
  const subscriptionIds = useLiveQuery(async () => {
    const ids = new Set<string>();
    for (const s of suggestions ?? []) {
      if (s.kind !== "bill") continue;
      const first = await db.entries.get(s.entry_ids[s.entry_ids.length - 1] ?? "");
      if (first?.category_id === "cat-subscriptions") ids.add(s.payee);
    }
    return ids;
  }, [db, suggestions]);
  const [busy, setBusy] = useState(false);
  if (!suggestions || suggestions.length === 0) return null;
  const bills = suggestions.filter((s) => s.kind === "bill");
  // Confirm all takes monthly-or-longer bills only; weekly ones are reviewed one by one on Bills.
  const bulk = bills.filter(inConfirmAll);
  const subs = bills.filter((s) => subscriptionIds?.has(s.payee)).length;
  const paycheck =
    suggestions
      .filter((s) => s.kind === "income" && PAY_FREQUENCY[s.interval])
      .sort((a, b) => b.expected_cents - a.expected_cents)[0] ?? null;
  // Once Budget has pay, the paycheck is settled: not offered, not counted (invariant 66's
  // sibling: a count says only what is still to do).
  const offerPay = paycheck !== null && !pay;
  if (bills.length === 0 && !offerPay) return null;

  async function confirmBills() {
    setBusy(true);
    try {
      for (const s of bulk) await confirmSuggestion(db, s);
    } finally {
      setBusy(false);
    }
  }

  async function usePay() {
    if (!paycheck) return;
    const frequency = PAY_FREQUENCY[paycheck.interval] as PayFrequency;
    // Twice a month and monthly keep the days found (invariant 49): the 15th and the last day
    // are 24 paychecks a year, never 26.
    const days =
      frequency === "semimonthly"
        ? paycheck.days
        : frequency === "monthly" && paycheck.day
          ? [paycheck.day]
          : null;
    const settings: PaySettings = {
      amount_cents: paycheck.expected_cents,
      frequency,
      next_payday: paycheck.next_date,
      monthly_cents: await monthlyTakeHome(paycheck.expected_cents, frequency),
      ...(days ? { days } : {}),
    };
    await db.settings.put({ key: "pay", value: settings, updated_at: new Date().toISOString() });
    // The pay settings carry the paycheck into the forecast; a confirmed series would count it twice.
    await dismissSuggestion(db, paycheck);
  }

  const counts: Array<[number, string]> = [
    [bills.length - subs, bills.length - subs === 1 ? "bill" : "bills"],
    [subs, subs === 1 ? "subscription" : "subscriptions"],
    [offerPay ? 1 : 0, "paycheck"],
  ];
  return (
    <Card as="section" aria-labelledby="home-found" className="found">
      <p className="sk-card__eyebrow">Found in your statements</p>
      <Word>Found</Word>
      <h2 className="found__title" id="home-found">
        {bills.length > 0 ? "Confirm to see what's coming" : "Your paycheck, spotted"}
      </h2>
      <div className="found__counts">
        {counts
          .filter(([n]) => n > 0)
          .map(([n, label]) => (
            <span className="found__count" key={label}>
              <strong>{n}</strong>
              <span>{label}</span>
            </span>
          ))}
      </div>
      {bills.length > 0 ? (
        <ul className="found__list" aria-label="Regular bills found">
          {bills.slice(0, 4).map((s) => (
            <li key={s.payee} className="found__item">
              <span className="found__name">{s.label}</span>
              <span className="found__meta">
                {formatCents(s.expected_cents)} · {suggestionInterval(s.interval)} · next{" "}
                {formatDay(s.next_date)}
              </span>
            </li>
          ))}
          {bills.length > 4 ? (
            <li className="found__more">
              <Link to="/bills">+{bills.length - 4} more</Link>
            </li>
          ) : null}
        </ul>
      ) : null}
      {offerPay && paycheck ? (
        <Button block variant={bills.length > 0 ? "secondary" : "primary"} onClick={usePay}>
          Use {formatCents(paycheck.expected_cents)}{" "}
          {suggestionInterval(paycheck.interval).toLowerCase()} as my pay
        </Button>
      ) : null}
      {bills.length > 0 ? (
        <div className="install-actions">
          <Link to="/bills" className={buttonClass({ variant: "secondary" })}>
            Review
          </Link>
          {bulk.length > 0 ? (
            <Button onClick={confirmBills} disabled={busy}>
              {bulk.length === bills.length
                ? `Confirm ${bills.length === 1 ? "it" : `all ${bills.length}`}`
                : `Confirm ${bulk.length} monthly`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
