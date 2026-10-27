import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import {
  type Account,
  type BalanceAnchor,
  ignoreClosed,
  newId,
  type PaySettings,
  type RecurringSeries,
  type StackdDb,
} from "../../data/db.ts";
import {
  engine,
  nextPaydays,
  type Projection,
  projectBalance,
  type SeriesInput,
  type StartBalance,
  startBalance,
  type TypicalDaily,
  typicalDailySpending,
  type Upcoming,
  upcomingItems,
} from "../../engine/bridge.ts";
import { useBudget } from "../budget/useBudget.ts";
import { toRecurringEntry } from "./useRecurring.ts";

export const FORECAST_DAYS = 30;
export const BUFFER_KEY = "forecast.buffer_cents";
export const ACCOUNT_KEY = "forecast.account_id";

export interface ForecastView {
  loading: boolean;
  account: Account | null;
  anchor: BalanceAnchor | null;
  start: StartBalance | null;
  daily: TypicalDaily | null;
  upcoming: Upcoming | null;
  projection: Projection | null;
  bufferCents: number;
  /** Series shown on the list: confirmed bills and income plus the paycheck from Budget's pay settings. */
  series: Map<string, { label: string; interval: string; source: "confirmed" | "pay" }>;
  needsBalance: boolean;
}

/** Budget's pay settings as income series the forecast can expand. */
export async function payAsSeries(
  pay: PaySettings | undefined,
  asOf: string,
): Promise<SeriesInput[]> {
  if (!pay?.next_payday || pay.amount_cents <= 0) return [];
  const base = { payee: "Paycheck", kind: "income" as const, expected_cents: pay.amount_cents };
  if (pay.frequency === "semimonthly") {
    const d = Number(pay.next_payday.slice(8, 10));
    const days = d <= 15 ? [d, d + 15] : [d - 15, d];
    const dates = await nextPaydays(asOf, { kind: "monthly_days", days }, 2);
    return dates.map((next, i) => ({
      ...base,
      id: `pay-${i}`,
      interval: "monthly",
      next_date: next,
    }));
  }
  return [{ ...base, id: "pay", interval: pay.frequency, next_date: pay.next_payday }];
}

export function pickAccount(
  accounts: Account[],
  anchors: BalanceAnchor[],
  preferred: string | undefined,
): Account | null {
  if (preferred) {
    const chosen = accounts.find((a) => a.id === preferred);
    if (chosen) return chosen;
  }
  // Spending money lives in checking (October 19, 2026): an anchored checking account wins, then
  // other cash accounts (savings, cash) by the newest anchor; a credit card is never picked on
  // its own. Before this the newest anchor won, so importing savings last moved the forecast
  // onto savings and "safe to spend" counted money set aside.
  const rank = (a: Account) => (a.type === "checking" ? 0 : a.type === "credit_card" ? 2 : 1);
  const anchored = [...anchors]
    .map((anchor) => ({ anchor, account: accounts.find((a) => a.id === anchor.account_id) }))
    .filter((x): x is { anchor: BalanceAnchor; account: Account } =>
      Boolean(x.account && x.account.type !== "credit_card"),
    )
    .sort(
      (a, b) =>
        rank(a.account) - rank(b.account) ||
        b.anchor.as_of.localeCompare(a.anchor.as_of) ||
        b.anchor.created_at.localeCompare(a.anchor.created_at),
    )[0];
  if (anchored) return anchored.account;
  return accounts.find((a) => a.type === "checking") ?? accounts[0] ?? null;
}

/**
 * The next 30 days from the engine: starting balance (latest anchor + entries since), typical
 * daily spending, every confirmed series and the paycheck expanded and matched to real entries,
 * then the day-by-day projection against the buffer. Stored in `forecasts` with its rules version.
 */
export function useForecast(asOf: string, days = FORECAST_DAYS): ForecastView {
  const { db } = useDb();
  const budget = useBudget(asOf, false);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [db]);
  const anchors = useLiveQuery(() => db.balance_anchors.toArray(), [db]);
  const entries = useLiveQuery(() => db.entries.toArray(), [db]);
  const confirmed = useLiveQuery(
    () => db.recurring_series.where("status").equals("confirmed").toArray(),
    [db],
  );
  const settings = useLiveQuery(
    async () => ({
      pay: (await db.settings.get("pay"))?.value as PaySettings | undefined,
      buffer: ((await db.settings.get(BUFFER_KEY))?.value as number | undefined) ?? 0,
      accountId: (await db.settings.get(ACCOUNT_KEY))?.value as string | undefined,
    }),
    [db],
  );
  const [view, setView] = useState<ForecastView>({
    loading: true,
    account: null,
    anchor: null,
    start: null,
    daily: null,
    upcoming: null,
    projection: null,
    bufferCents: 0,
    series: new Map(),
    needsBalance: false,
  });
  const budgetSummary = budget.summary;
  const budgetLoaded = budget.budget !== undefined;

  useEffect(() => {
    if (!accounts || !anchors || !entries || !confirmed || !settings || !budgetLoaded) return;
    let alive = true;
    void (async () => {
      const account = pickAccount(accounts, anchors, settings.accountId);
      const anchor = account
        ? ([...anchors]
            .filter((a) => a.account_id === account.id)
            .sort(
              (a, b) => b.as_of.localeCompare(a.as_of) || b.created_at.localeCompare(a.created_at),
            )[0] ?? null)
        : null;
      const since = account
        ? entries.filter((e) => e.account_id === account.id && !e.split_parent_id)
        : [];
      const start = await startBalance(
        anchor ? { as_of: anchor.as_of, balance_cents: anchor.balance_cents } : null,
        since.map((e) => ({ date: e.date, amount_cents: e.amount_cents, direction: e.direction })),
      );
      const fallback = (budgetSummary?.buckets ?? [])
        .filter((b) => b.bucket === "need" || b.bucket === "want")
        .reduce((sum, b) => sum + b.planned_cents, 0);
      // A not-counted entry still moved money (the balance keeps it) but isn't typical spending.
      const past = entries.filter((e) => e.date <= asOf && !e.split_parent_id && !e.not_counted);
      const daily = await typicalDailySpending(
        past.map((e) => ({
          date: e.date,
          amount_cents: e.amount_cents,
          direction: e.direction,
          is_transfer: e.is_transfer,
          is_recurring: e.is_recurring,
        })),
        asOf,
        fallback,
      );
      const pay = await payAsSeries(settings.pay, asOf);
      const inputs: SeriesInput[] = [
        ...confirmed.map((s: RecurringSeries) => ({
          id: s.id,
          payee: s.payee,
          kind: s.kind,
          expected_cents: s.expected_cents,
          interval: s.interval,
          next_date: s.next_date,
        })),
        ...pay,
      ];
      const upcoming = await upcomingItems(
        inputs,
        entries.filter((e) => !e.split_parent_id).map(toRecurringEntry),
        asOf,
        days,
      );
      const projection =
        start.balance_cents === null
          ? null
          : await projectBalance(
              asOf,
              start.balance_cents,
              daily.cents_per_day,
              upcoming.items,
              settings.buffer,
              days,
            );
      if (!alive) return;
      const series = new Map<
        string,
        { label: string; interval: string; source: "confirmed" | "pay" }
      >();
      for (const s of confirmed)
        series.set(s.id, { label: s.label, interval: s.interval, source: "confirmed" });
      for (const p of pay)
        series.set(p.id, { label: "Paycheck", interval: p.interval, source: "pay" });
      setView({
        loading: false,
        account,
        anchor,
        start,
        daily,
        upcoming,
        projection,
        bufferCents: settings.buffer,
        series,
        needsBalance: start.balance_cents === null,
      });
      const stamp = new Date().toISOString();
      const version = engine.rulesVersion ?? "unknown";
      // Only the 30-day forecast is kept: Home and alerts read it; a quarter or a year is a view.
      if (projection && days === FORECAST_DAYS) {
        await db.forecasts.put({
          id: asOf,
          as_of: asOf,
          rules_version: version,
          lowest_cents: projection.lowest_cents,
          lowest_date: projection.lowest_date,
          shortfall: projection.shortfall,
          short_by_cents: projection.short_by_cents,
          payload: {
            projection,
            start,
            daily,
            upcoming,
            buffer_cents: settings.buffer,
            account_id: account?.id ?? null,
          },
          computed_at: stamp,
        });
        await db.computed_results.put({
          id: `forecast:${asOf}`,
          kind: "forecast",
          as_of: asOf,
          rules_version: version,
          payload: projection,
          computed_at: stamp,
        });
      }
      // An expected item that matched a real entry marks that entry as recurring spending.
      const matched = upcoming.items
        .filter((i) => i.matched && i.entry_id)
        .map((i) => i.entry_id as string)
        .filter((id) => entries.find((e) => e.id === id)?.is_recurring === false);
      if (matched.length) {
        await db.entries.bulkUpdate(
          matched.map((key) => ({ key, changes: { is_recurring: true, updated_at: stamp } })),
        );
      }
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [
    db,
    accounts,
    anchors,
    entries,
    confirmed,
    settings,
    budgetSummary,
    budgetLoaded,
    asOf,
    days,
  ]);

  return view;
}

export async function setBuffer(db: StackdDb, cents: number): Promise<void> {
  await db.settings.put({ key: BUFFER_KEY, value: cents, updated_at: new Date().toISOString() });
}

/** "What's in your account right now?": a user-entered balance becomes today's anchor. */
export async function setBalance(
  db: StackdDb,
  accountId: string,
  cents: number,
  asOf: string,
): Promise<void> {
  await db.balance_anchors.add({
    id: newId(),
    account_id: accountId,
    as_of: asOf,
    balance_cents: cents,
    source: "user",
    created_at: new Date().toISOString(),
  });
  await db.settings.put({
    key: ACCOUNT_KEY,
    value: accountId,
    updated_at: new Date().toISOString(),
  });
}
