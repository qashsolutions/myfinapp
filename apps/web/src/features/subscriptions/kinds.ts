import keywordsConfig from "@stackd/rules/keywords";
import { useLiveQuery } from "dexie-react-hooks";
import { useDb } from "../../data/DbProvider.tsx";
import type { StackdDb } from "../../data/db.ts";
import { THRESHOLDS } from "../insights/thresholds.ts";

interface KeywordsConfig {
  subscription_kinds: Array<{ match: string; kind: string }>;
  subscription_kind_names: Array<{ kind: string; label: string; many: string }>;
}
const CONFIG = keywordsConfig as KeywordsConfig;

/** The hand-edited subscription kinds (config/keywords.yaml `subscription_kinds`). */
export const KIND_TABLE = CONFIG.subscription_kinds;
/** The fixed list a person picks a subscription's kind from (plus Other, no kind). */
export const KIND_NAMES = CONFIG.subscription_kind_names;
/** The person's "Other": no kind, whatever the name says (the rule's `OTHER_KIND`). */
export const OTHER_KIND = "other";

const NAMES = new Map(KIND_NAMES.map((k) => [k.kind, k] as const));

/**
 * "video" → "Video streaming"; null → "No kind"; one of the person's own kinds → its name (from
 * `own`, their kind id → name). A kind no longer in either list reads as is.
 */
export function kindLabel(kind: string | null, own?: ReadonlyMap<string, string>): string {
  if (kind === null) return "No kind";
  return NAMES.get(kind)?.label ?? own?.get(kind) ?? kind;
}

/**
 * "video" → "video services", for "3 video services · $47 a month together"; an own kind reads
 * "subscriptions in Kids" ("2 subscriptions in Kids · $25 a month together").
 */
export function kindMany(kind: string, own?: ReadonlyMap<string, string>): string {
  const builtIn = NAMES.get(kind)?.many;
  if (builtIn) return builtIn;
  const mine = own?.get(kind);
  return mine ? `subscriptions in ${mine}` : `${kind} services`;
}

/** The person's own kind on a subscription: a kind, "other" (none), or null (from the name). */
export async function setSubscriptionKind(
  db: StackdDb,
  id: string,
  kind: string | null,
): Promise<void> {
  await db.recurring_series.update(id, {
    subscription_kind: kind,
    updated_at: new Date().toISOString(),
  });
}

/** The two intervals the person can adjust (owner sign-off, October 29, 2026). */
export const ASK_SETTING = "subscriptions.ask_days";
export const RENEWAL_SETTING = "subscriptions.renewal_days";
export const ASK_CHOICES = [30, 60, 90] as const;
export const ASK_RANGE = { min: 7, max: 365 } as const;
export const RENEWAL_CHOICES = [15, 30] as const;
export const RENEWAL_RANGE = { min: 1, max: 90 } as const;

export interface CheckIntervals {
  /** "Still using it?" comes back this many days after the last Keep. */
  askDays: number;
  /** A yearly or quarterly renewal this close is shown and asked about. */
  renewalDays: number;
}

/** The config defaults (config/insights.yaml), used until the person picks their own. */
export const DEFAULT_INTERVALS: CheckIntervals = {
  askDays: THRESHOLDS.subscription_ask_days as number,
  renewalDays: THRESHOLDS.subscription_renewal_days as number,
};

function readDays(value: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= range.min &&
    value <= range.max
    ? value
    : fallback;
}

/** The person's intervals, else the defaults (live). */
export function useCheckIntervals(): CheckIntervals | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [ask, renewal] = await Promise.all([
      db.settings.get(ASK_SETTING),
      db.settings.get(RENEWAL_SETTING),
    ]);
    return {
      askDays: readDays(ask?.value, ASK_RANGE, DEFAULT_INTERVALS.askDays),
      renewalDays: readDays(renewal?.value, RENEWAL_RANGE, DEFAULT_INTERVALS.renewalDays),
    };
  }, [db]);
}

/** The thresholds the rule takes, with the person's two intervals over the config's. */
export function checkThresholds(intervals: CheckIntervals): Record<string, number> {
  return {
    ...THRESHOLDS,
    subscription_ask_days: intervals.askDays,
    subscription_renewal_days: intervals.renewalDays,
  };
}
