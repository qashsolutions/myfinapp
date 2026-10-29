import "../bills/cards.css";
import "../auth/auth.css";

import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import type { CardTrend, CreditHabits } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import {
  CREDIT_GUIDE_BPS,
  type CreditCardView,
  leadCard,
  useCreditCards,
} from "./useCreditCards.ts";

/** Fixed, short, on every credit-habits surface (October 28, 2026). */
export const CREDIT_DISCLAIMER = "Education only. Qash never sees or shows a credit score.";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function pctText(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}

/** The one word: Steady (every checked due date on time), Missed (the latest one missed),
 * Building (on time lately, a miss further back), Start (nothing to check yet). */
export function habitsWord(h: CreditHabits | null): string {
  if (!h?.status) return "Start";
  return { steady: "Steady", building: "Building", missed: "Missed" }[h.status];
}

/** The short lines under the word, each straight from the rule's numbers. */
export const NEEDS_BALANCE = "Set the card's balance to start checking";

/** Nothing could be checked because no balance is known on or before any due date. */
export function needsBalance(h: CreditHabits): boolean {
  return h.checked === 0 && h.unknown > 0;
}

export function habitLines(h: CreditHabits): string[] {
  const lines: string[] = [];
  if (needsBalance(h)) {
    lines.push(NEEDS_BALANCE);
  } else if (h.on_time_streak > 0) {
    lines.push(`${plural(h.on_time_streak, "payment", "payments")} on time in a row`);
  } else if (h.latest_due_date) {
    lines.push(`Missed the ${formatDay(h.latest_due_date)} due date`);
  }
  if (h.utilization_bps !== null) {
    lines.push(
      `${pctText(h.utilization_bps)} of your limit used · ${h.under_guide ? "under" : "over"} ${pctText(CREDIT_GUIDE_BPS)}`,
    );
  }
  if (h.paid_in_full_streak) {
    lines.push(`Paid in full ${plural(h.paid_in_full_streak, "month", "months")}`);
  }
  return lines;
}

export function trendWord(t: CardTrend): string | null {
  return t.trend ? { growing: "Growing", shrinking: "Shrinking", steady: "Steady" }[t.trend] : null;
}

/** A card's spending against payments: one word, then last month's two numbers. */
export function CardTrendLine({ trend }: { trend: CardTrend }) {
  const last = trend.last_month;
  if (!last) return null;
  const word = trendWord(trend);
  return (
    <div className="card-trend">
      {word ? <Word>{word}</Word> : null}
      <span className="card-facts__sub">
        Spent {formatCents(last.spent_cents)}, paid {formatCents(last.paid_cents)} last month
      </span>
    </div>
  );
}

/** Bills → Debt payoff, at the top when there is a card: the lead card's habits, one tap from
 * the detail. */
export function CreditHabitsCard() {
  const cards = useCreditCards(todayIso());
  if (!cards || cards.length === 0) return null;
  const lead = leadCard(cards);
  return (
    <Card as="section" aria-labelledby="credit-habits-h">
      <h2 className="sk-card__title" id="credit-habits-h">
        Credit habits{lead && cards.length > 1 ? ` · ${lead.account.label}` : ""}
      </h2>
      <Word>{habitsWord(lead?.habits ?? null)}</Word>
      {lead?.habits ? (
        <ul className="habit-lines">
          {habitLines(lead.habits).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="sk-card__eyebrow">Set a payment due day on your card to start</p>
      )}
      <p>
        <Link to="/credit-habits" className="auth__link">
          See each card
        </Link>
      </p>
      <p className="auth__fineprint">{CREDIT_DISCLAIMER}</p>
    </Card>
  );
}

/** Unlinked cards' spending against payments on Debt payoff (linked cards show it on their own
 * facts card). */
export function CardSpending() {
  const cards = useCreditCards(todayIso());
  const shown = (cards ?? []).filter((c) => !c.account.linked && c.trend.last_month);
  if (shown.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="card-spending-h">
      <h2 className="sk-card__title" id="card-spending-h">
        Card spending vs payments
      </h2>
      {shown.map((c) => (
        <div key={c.account.id}>
          <p className="card-facts__name">{cardName(c)}</p>
          <CardTrendLine trend={c.trend} />
        </div>
      ))}
    </Card>
  );
}

function cardName(c: CreditCardView): string {
  return `${c.account.label}${c.account.last4 ? ` ••${c.account.last4}` : ""}`;
}

/** `/credit-habits`: each card with its word, lines, spending against payments, and why. */
export function CreditHabitsScreen() {
  const cards = useCreditCards(todayIso());
  return (
    <>
      <ScreenHeader title="Credit habits" back="/bills?tab=debt" actions={null} />
      {cards && cards.length === 0 ? (
        <Card>
          <Word>Start</Word>
          <p>Add a credit card account to see its payment habits here.</p>
          <Link to="/me/accounts" className="auth__link">
            Accounts
          </Link>
        </Card>
      ) : null}
      {cards?.map((c) => (
        <Card as="article" aria-label={cardName(c)} key={c.account.id} className="card-facts">
          <span className="card-facts__name">{cardName(c)}</span>
          <Word>{habitsWord(c.habits)}</Word>
          {c.habits ? (
            <ul className="habit-lines">
              {habitLines(c.habits).map((l) => (
                <li key={l}>{l}</li>
              ))}
              {c.habits.missed.length > 1 ? (
                <li>
                  {plural(c.habits.missed.length, "due date", "due dates")} missed in the window
                </li>
              ) : null}
              {c.habits.next_due_date ? (
                <li>Next due {formatDay(c.habits.next_due_date)}</li>
              ) : null}
              {needsBalance(c.habits) ? (
                <li>
                  <Link to="/me/accounts" className="auth__link">
                    Set the balance in Accounts
                  </Link>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="sk-card__eyebrow">
              {c.account.linked ? (
                "Due dates arrive with your card's next statement"
              ) : (
                <>
                  No due date yet.{" "}
                  <Link to="/me/accounts" className="auth__link">
                    Set a payment due day
                  </Link>
                </>
              )}
            </p>
          )}
          <CardTrendLine trend={c.trend} />
        </Card>
      ))}
      <Card as="section" aria-labelledby="credit-why-h">
        <h2 className="sk-card__title" id="credit-why-h">
          Why these matter
        </h2>
        <ul className="habit-lines">
          <li>Paying at least the minimum by each due date is what lenders look at most.</li>
          <li>
            Using less of your limit shows you are not stretched; under {pctText(CREDIT_GUIDE_BPS)}{" "}
            is a common guide.
          </li>
          <li>Paying the whole statement means no interest on what you bought.</li>
        </ul>
        <p className="auth__fineprint">
          On time means payments after the last due date add up to the minimum (or more than $0 when
          the minimum isn't known) by the due date. {CREDIT_DISCLAIMER}
        </p>
      </Card>
    </>
  );
}
