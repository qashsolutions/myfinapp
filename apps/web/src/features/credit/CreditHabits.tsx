import "../bills/cards.css";
import "../bills/visuals.css";
import "../auth/auth.css";

import { Button, buttonClass, Card, Sheet } from "@stackd/ui";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { CardTrend, CreditHabits } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";
import { saveSetting } from "../bills/debtPlan.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { DUE_DAY_OPTIONS } from "../settings/AccountsManager.tsx";
import { CardPairBars, DueDots, FullStreak, LimitGauge } from "./CreditPictures.tsx";
import {
  CREDIT_GUIDE_BPS,
  type CreditCardView,
  GUIDE_SETTING,
  leadCard,
  useCreditCards,
} from "./useCreditCards.ts";

/** Fixed, short, on every credit-habits surface (October 28, 2026). */
export const CREDIT_DISCLAIMER = "Education only. Qash never sees or shows a credit score.";

/** Suggested guides for the limit used; the person may take any whole percent 1 to 100
 * (signed off by the owner, October 29, 2026: 10 / 30 / 50, default 30). */
export const GUIDE_OPTIONS: Array<[string, string]> = [
  ["1000", "10%"],
  ["3000", "30%"],
  ["5000", "50%"],
];

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

export function habitLines(h: CreditHabits, guideBps: number = CREDIT_GUIDE_BPS): string[] {
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
      `${pctText(h.utilization_bps)} of your limit used · ${h.under_guide ? "under" : "over"} ${pctText(guideBps)}`,
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

/** A card's spending against payments: one word, last month's two numbers, then the months as
 * paired bars (October 29, 2026). */
export function CardTrendLine({ trend }: { trend: CardTrend }) {
  const last = trend.last_month;
  if (!last) return null;
  const word = trendWord(trend);
  return (
    <div className="card-facts__use">
      <div className="card-trend">
        {word ? <Word>{word}</Word> : null}
        <span className="card-facts__sub">
          Spent {formatCents(last.spent_cents)}, paid {formatCents(last.paid_cents)} last month
        </span>
      </div>
      <CardPairBars trend={trend} />
    </div>
  );
}

/** Bills → Debt payoff, at the top when there is a card: the lead card's habits as the dot
 * strip and its lines, one tap from the detail. */
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
        <>
          <DueDots habits={lead.habits} />
          <ul className="habit-lines">
            {habitLines(lead.habits, lead.guideBps).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
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

/**
 * "Adjust credit habits" (October 29, 2026): the person's own guide for the limit used (10 / 30
 * / 50% or any whole percent 1 to 100, kept in `settings` `credit.guide_bps`, read by the rule's
 * `guide_bps`) and each unlinked card's payment due day (the same `accounts.due_day` as
 * Accounts). Each change saves at once.
 */
export function AdjustCreditSheet({
  open,
  onClose,
  cards,
  guideBps,
}: {
  open: boolean;
  onClose: () => void;
  cards: CreditCardView[];
  guideBps: number;
}) {
  const { db } = useDb();
  const ids = useId();
  const unlinked = cards.filter((c) => !c.account.linked);
  return (
    <Sheet open={open} onClose={onClose} title="Adjust credit habits">
      <ChipsOrOwn
        name={`${ids}-guide`}
        legend="Guide for the limit used"
        options={GUIDE_OPTIONS}
        value={String(guideBps)}
        display={(v) => String(Number(v) / 100)}
        onPick={(v) => void saveSetting(db, GUIDE_SETTING, Number(v))}
        own={{
          label: "Your own guide, 1 to 100 percent",
          placeholder: "Or your own: 1 to 100%",
          parse: (t) => {
            const n = parseWholeNumber(t.replace("%", ""), 1, 100);
            return n === null
              ? { error: "Pick a whole percent from 1 to 100." }
              : { value: String(n * 100) };
          },
        }}
      />
      <p className="auth__hint">The limit-used bar marks this line. 30% is a common guide.</p>
      {unlinked.map((c) => (
        <ChipsOrOwn
          key={c.account.id}
          name={`${ids}-due-${c.account.id}`}
          legend={`Payment due day · ${cardName(c)}`}
          options={DUE_DAY_OPTIONS}
          value={c.account.due_day ? String(c.account.due_day) : ""}
          onPick={(v) => void db.accounts.update(c.account.id, { due_day: v ? Number(v) : null })}
          own={{
            label: `Own due day for ${c.account.label}, 1 to 31`,
            placeholder: "Day 1 to 31",
            parse: (text) => {
              const n = parseWholeNumber(text, 1, 31);
              return n === null ? { error: "Pick a day from 1 to 31." } : { value: String(n) };
            },
          }}
        />
      ))}
      {cards.length > unlinked.length ? (
        <p className="auth__hint">Linked cards take their due dates from the bank.</p>
      ) : null}
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

/** `/credit-habits`: each card with its word, due-date dots, limit gauge, paid-in-full count,
 * spending against payments, and why. */
export function CreditHabitsScreen() {
  const cards = useCreditCards(todayIso());
  const [adjusting, setAdjusting] = useState(false);
  const guide = cards?.[0]?.guideBps ?? CREDIT_GUIDE_BPS;
  return (
    <>
      <ScreenHeader
        title="Credit habits"
        back="/bills?tab=debt"
        actions={
          cards && cards.length > 0 ? (
            <button
              type="button"
              className={buttonClass({ variant: "secondary", size: "sm" })}
              aria-label="Adjust credit habits"
              onClick={() => setAdjusting(true)}
            >
              Adjust
            </button>
          ) : null
        }
      />
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
            <>
              <DueDots habits={c.habits} />
              <ul className="habit-lines">
                {habitLines(c.habits, c.guideBps)
                  .filter((l) => !l.startsWith("Paid in full"))
                  .map((l) => (
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
              <LimitGauge habits={c.habits} guideBps={c.guideBps} />
              <FullStreak habits={c.habits} />
            </>
          ) : (
            <p className="sk-card__eyebrow">
              {c.account.linked ? (
                "Due dates arrive with your card's next statement"
              ) : (
                <>
                  No due date yet.{" "}
                  <button type="button" className="auth__link" onClick={() => setAdjusting(true)}>
                    Set a payment due day
                  </button>
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
      {cards && cards.length > 0 ? (
        <AdjustCreditSheet
          open={adjusting}
          onClose={() => setAdjusting(false)}
          cards={cards}
          guideBps={guide}
        />
      ) : null}
    </>
  );
}
