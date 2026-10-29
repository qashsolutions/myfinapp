import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, ignoreClosed } from "../../data/db.ts";
import { type CardTrend, type CreditHabits, cardTrend, creditHabits } from "../../engine/bridge.ts";
import { byLabel, compareText } from "../../lib/order.ts";
import { THRESHOLDS } from "../insights/thresholds.ts";

export interface CreditCardView {
  account: Account;
  /** null until the card has a due date to check against (linked facts or a due day). */
  habits: CreditHabits | null;
  trend: CardTrend;
}

/** Thresholds from config/insights.yaml (proposed October 28, 2026, awaiting owner sign-off). */
export const CREDIT_GUIDE_BPS = THRESHOLDS.credit_guide_bps ?? 3000;
const HABIT_MONTHS = THRESHOLDS.credit_habits_months ?? 12;
const TREND_MONTHS = THRESHOLDS.card_trend_months ?? 6;

/**
 * Every credit card account on this device with its spending against payments
 * (`credit.card_trend`) and its credit habits (`credit.habits`; October 28, 2026). Payments are
 * the card's money in (the transfer side included); due dates are the ones its linked facts
 * showed (`card_due_dates`) or the person's own due day. Education only: nothing leaves the
 * device and no score is involved.
 */
export function useCreditCards(asOf: string): CreditCardView[] | undefined {
  const { db } = useDb();
  const source = useLiveQuery(async () => {
    const cards = (await db.accounts.toArray()).filter((a) => a.type === "credit_card");
    const ids = cards.map((a) => a.id);
    const [entries, details, dues, anchors] = await Promise.all([
      ids.length ? db.entries.where("account_id").anyOf(ids).toArray() : [],
      db.card_details.toArray(),
      db.card_due_dates.toArray(),
      db.balance_anchors.toArray(),
    ]);
    return { cards, entries, details, dues, anchors };
  }, [db]);
  const [views, setViews] = useState<CreditCardView[] | undefined>(undefined);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    void (async () => {
      const out: CreditCardView[] = [];
      for (const account of [...source.cards].sort((a, b) => byLabel(a.label, b.label))) {
        const mine = source.entries.filter((e) => e.account_id === account.id);
        const trend = await cardTrend(
          mine.map((e) => ({ date: e.date, direction: e.direction, amount_cents: e.amount_cents })),
          asOf,
          TREND_MONTHS,
        );
        const detail = account.linked
          ? source.details.find((d) => d.account_id === account.id)
          : undefined;
        const dues = account.linked ? source.dues.filter((d) => d.account_id === account.id) : [];
        const dueDay = account.due_day ?? null;
        let habits: CreditHabits | null = null;
        if (dues.length > 0 || dueDay !== null) {
          const latest = source.anchors
            .filter((a) => a.account_id === account.id)
            .sort((a, b) => compareText(b.as_of, a.as_of))[0];
          habits = await creditHabits({
            dueDates: [],
            dueDay,
            payments: mine
              .filter((e) => e.direction === "in")
              .map((e) => ({ date: e.date, cents: e.amount_cents })),
            minimumCents: detail?.minimum_cents ?? null,
            statements: dues.map((d) => ({
              due_date: d.due_date,
              balance_cents: d.statement_balance_cents,
              minimum_cents: d.minimum_cents,
            })),
            statementBalanceCents: detail?.statement_balance_cents ?? null,
            // A card's anchor is negative (what is owed); the rule wants the amount owed.
            currentBalanceCents: latest ? -latest.balance_cents : null,
            limitCents: detail?.limit_cents ?? null,
            asOf,
            months: HABIT_MONTHS,
            guideBps: CREDIT_GUIDE_BPS,
            since: mine.reduce<string | null>(
              (min, e) => (min === null || compareText(e.date, min) < 0 ? e.date : min),
              null,
            ),
          });
        }
        out.push({ account, habits, trend });
      }
      if (alive) setViews(out);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [source, asOf]);
  return views;
}

const RANK = { missed: 0, building: 1, steady: 2 } as const;

/** The card that most needs a look leads a summary: missed, then building, then steady. */
export function leadCard(views: CreditCardView[]): CreditCardView | null {
  const checked = views.filter((v) => v.habits?.status);
  if (checked.length === 0) return null;
  return (
    [...checked].sort(
      (a, b) =>
        RANK[a.habits?.status ?? "steady"] - RANK[b.habits?.status ?? "steady"] ||
        byLabel(a.account.label, b.account.label),
    )[0] ?? null
  );
}
