import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, type Debt, ignoreClosed, type StackdDb } from "../../data/db.ts";
import {
  avalancheOrder,
  type DebtInput,
  type PayoffOrder,
  type PayoffPlan,
  payoffPlan,
} from "../../engine/bridge.ts";
import { byLabel, compareText } from "../../lib/order.ts";

/** The extra each month on top of the minimums (fast-follow 1). */
export const EXTRA_SETTING = "debt.extra_cents";
/** Which debt gets the extra first (October 28, 2026); synced like other settings. */
export const ORDER_SETTING = "debt.order";

/** The two fixed ways to order debts, each with its one plain line (a kind, so fixed chips). */
export const PAYOFF_ORDERS: ReadonlyArray<{ value: PayoffOrder; label: string; line: string }> = [
  { value: "avalanche", label: "Highest rate first", line: "Saves the most interest." },
  { value: "snowball", label: "Smallest balance first", line: "Clears a debt sooner." },
];

export function orderLabel(order: PayoffOrder): string {
  return PAYOFF_ORDERS.find((o) => o.value === order)?.label ?? "";
}

/** A linked card's own choices for the plan (October 29, 2026), synced like other settings:
 * the APR or minimum the person gave when the issuer sent none, and whether to leave it out. */
export const CARD_SETTING_PREFIX = "debt.card.";

export interface CardPlanChoice {
  apr_bps?: number | null;
  min_payment_cents?: number | null;
  left_out?: boolean;
}

/** A debt in the plan; a linked card's carries its device account (id `card:<account>`). */
export interface PlanDebt extends Debt {
  card_account_id: string | null;
}

/** One linked card and how it stands in the plan. */
export interface CardInPlan {
  account: Account;
  /** What is owed now: the bank's latest balance (a card's anchor is negative), else the
   * statement balance; null when the bank has sent neither yet. */
  owed_cents: number | null;
  apr_bps: number | null;
  apr_from: "issuer" | "yours" | "debt" | null;
  min_payment_cents: number | null;
  min_from: "issuer" | "yours" | "debt" | null;
  /** The hand-added debt the person said is this card, if any. */
  paired: Debt | null;
  left_out: boolean;
  status: "in_plan" | "needs" | "left_out" | "nothing_owed";
}

export interface PlanDebts {
  /** What the payoff plan, Home, What if, the month review and the comparison use. */
  debts: PlanDebt[];
  /** Every linked card, in the plan or not, with why. */
  cards: CardInPlan[];
  /** Hand-added debts not paired with a linked card. */
  unpaired: Debt[];
}

export function cardDebtId(accountId: string): string {
  return `card:${accountId}`;
}

/**
 * The debts the plan counts, once each (invariant 65): every hand-added debt, and every linked
 * credit card at the bank's balance with the issuer's APR and minimum (or the person's own when
 * the issuer sent none). A hand-added debt the person paired with a linked card is that card,
 * not a second debt; a card still waiting for its APR or minimum, left out, or owing nothing is
 * not in the plan and says why.
 */
export async function readPlanDebts(db: StackdDb): Promise<PlanDebts> {
  const [hand, accounts, details, anchors, choices] = await Promise.all([
    db.debts.toArray(),
    db.accounts.toArray(),
    db.card_details.toArray(),
    db.balance_anchors.toArray(),
    db.settings.where("key").startsWith(CARD_SETTING_PREFIX).toArray(),
  ]);
  const linkedCards = accounts
    .filter((a) => a.type === "credit_card" && a.linked)
    .sort((a, b) => byLabel(a.label, b.label) || compareText(a.id, b.id));
  const linkedIds = new Set(linkedCards.map((a) => a.id));
  const cards: CardInPlan[] = linkedCards.map((account) => {
    const detail = details.find((d) => d.account_id === account.id);
    const latest = anchors
      .filter((x) => x.account_id === account.id)
      .sort((x, y) => compareText(y.as_of, x.as_of) || compareText(y.created_at, x.created_at))[0];
    const owed = latest
      ? Math.max(0, -latest.balance_cents)
      : (detail?.statement_balance_cents ?? null);
    const choice = (choices.find((c) => c.key === `${CARD_SETTING_PREFIX}${account.id}`)?.value ??
      {}) as CardPlanChoice;
    const paired = hand.find((d) => d.account_id === account.id) ?? null;
    const [apr, aprFrom] = firstOf(detail?.apr_bps, choice.apr_bps, paired?.apr_bps);
    const [min, minFrom] = firstOf(
      detail?.minimum_cents,
      choice.min_payment_cents,
      paired?.min_payment_cents,
    );
    const leftOut = choice.left_out === true;
    const status: CardInPlan["status"] = leftOut
      ? "left_out"
      : owed === 0
        ? "nothing_owed"
        : owed === null || apr === null || min === null
          ? "needs"
          : "in_plan";
    return {
      account,
      owed_cents: owed,
      apr_bps: apr,
      apr_from: aprFrom,
      min_payment_cents: min,
      min_from: minFrom,
      paired,
      left_out: leftOut,
      status,
    };
  });
  const stamp = new Date(0).toISOString();
  const cardDebts: PlanDebt[] = cards
    .filter((c) => c.status === "in_plan")
    .map((c) => ({
      id: cardDebtId(c.account.id),
      label: c.paired?.label ?? cardName(c.account),
      balance_cents: c.owed_cents ?? 0,
      apr_bps: c.apr_bps ?? 0,
      min_payment_cents: c.min_payment_cents ?? 0,
      account_id: c.account.id,
      card_account_id: c.account.id,
      created_at: c.paired?.created_at ?? c.account.created_at ?? stamp,
      updated_at: c.paired?.updated_at ?? stamp,
    }));
  // A debt paired with a card still linked is that card: counted once, above.
  const standing = hand.filter((d) => !(d.account_id && linkedIds.has(d.account_id)));
  return {
    debts: [...standing.map((d) => ({ ...d, card_account_id: null })), ...cardDebts],
    cards,
    unpaired: standing,
  };
}

function firstOf(
  issuer: number | null | undefined,
  yours: number | null | undefined,
  debt: number | null | undefined,
): [number | null, CardInPlan["apr_from"]] {
  if (typeof issuer === "number") return [issuer, "issuer"];
  if (typeof yours === "number") return [yours, "yours"];
  if (typeof debt === "number") return [debt, "debt"];
  return [null, null];
}

export function cardName(account: Pick<Account, "label" | "last4">): string {
  return `${account.label}${account.last4 ? ` ••${account.last4}` : ""}`;
}

/** The plan's debts, live. */
export function usePlanDebts(): PlanDebts | undefined {
  const { db } = useDb();
  return useLiveQuery(() => readPlanDebts(db), [db]);
}

/** Saves a linked card's own choice for the plan, merged into what is there. */
export async function saveCardChoice(
  db: StackdDb,
  accountId: string,
  change: CardPlanChoice,
): Promise<void> {
  const key = `${CARD_SETTING_PREFIX}${accountId}`;
  await db.transaction("rw", db.settings, async () => {
    const now = ((await db.settings.get(key))?.value ?? {}) as CardPlanChoice;
    await db.settings.put({
      key,
      value: { ...now, ...change },
      updated_at: new Date().toISOString(),
    });
  });
}

/** Pairs a hand-added debt with a linked card (or, with null, unpairs it). */
export async function pairDebt(db: StackdDb, debtId: string, accountId: string | null) {
  await db.transaction("rw", db.debts, async () => {
    if (accountId) {
      // One debt per card: another debt paired with it lets go.
      const others = await db.debts.filter((d) => d.account_id === accountId).toArray();
      for (const o of others)
        if (o.id !== debtId)
          await db.debts.update(o.id, { account_id: null, updated_at: new Date().toISOString() });
    }
    await db.debts.update(debtId, { account_id: accountId, updated_at: new Date().toISOString() });
  });
}

export function debtInputs(debts: Debt[]): DebtInput[] {
  return debts.map((d) => ({
    id: d.id,
    label: d.label,
    balance_cents: d.balance_cents,
    apr_bps: d.apr_bps,
    min_payment_cents: d.min_payment_cents,
  }));
}

function readOrder(value: unknown): PayoffOrder {
  return value === "snowball" ? "snowball" : "avalanche";
}

export interface DebtSettings {
  debts: PlanDebt[];
  cards: CardInPlan[];
  unpaired: Debt[];
  extra: number;
  order: PayoffOrder;
}

/** The plan's debts (hand-added and linked cards, once each) with the person's extra and
 * order (live). */
export function useDebtSettings(): DebtSettings | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [plan, extra, order] = await Promise.all([
      readPlanDebts(db),
      db.settings.get(EXTRA_SETTING),
      db.settings.get(ORDER_SETTING),
    ]);
    return {
      ...plan,
      extra: (extra?.value as number | undefined) ?? 0,
      order: readOrder(order?.value),
    };
  }, [db]);
}

export async function saveSetting(db: StackdDb, key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value, updated_at: new Date().toISOString() });
}

/** The plan at the person's extra and order, straight from `bills.payoff_plan`; null with no
 * debts, undefined while loading. Home's Debt-free card and Bills share it. */
export function useDebtFreePlan(asOf: string): PayoffPlan | null | undefined {
  const settings = useDebtSettings();
  const [plan, setPlan] = useState<PayoffPlan | null | undefined>(undefined);
  useEffect(() => {
    if (!settings) return;
    if (settings.debts.length === 0) {
      setPlan(null);
      return;
    }
    let alive = true;
    void payoffPlan(debtInputs(settings.debts), settings.extra, asOf, settings.order)
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [settings, asOf]);
  return plan;
}

/** Every debt's balance added up (`bills.avalanche_order`'s total): where the payoff line
 * starts. Null with no debts, undefined while loading. */
export function useDebtTotal(): number | null | undefined {
  const settings = useDebtSettings();
  const [total, setTotal] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!settings) return;
    if (settings.debts.length === 0) {
      setTotal(null);
      return;
    }
    let alive = true;
    void avalancheOrder(debtInputs(settings.debts))
      .then((o) => {
        if (alive) setTotal(o.total_balance_cents);
      })
      .catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [settings]);
  return total;
}
