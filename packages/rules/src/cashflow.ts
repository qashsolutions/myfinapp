/**
 * Port of stackd_rules/cashflow.py: Month In, Out and Net (transfers excluded, refunds net
 * against their category), and transfer matching across the user's accounts.
 */

import { addDays, addMonths, type Day, daysUntil, iso, monthBounds, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, ratioBps, roundDiv } from "./money.ts";
import { compareText } from "./text.ts";

type Direction = "in" | "out";
type Kind = "expense" | "income" | null;

interface Entry {
  id: string | null;
  date: Day;
  cents: number;
  direction: Direction;
  is_transfer: boolean;
  category_id: string | null;
  category_kind: Kind;
  account_id: string;
}

function entry(raw: unknown): Entry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new RuleError("invalid_entry");
  const r = raw as Record<string, unknown>;
  const date = parseDate(r.date);
  const cents = assertInt(r.amount_cents);
  if (cents < 0) throw new RuleError("invalid_amount");
  if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
  if (typeof r.is_transfer !== "boolean") throw new RuleError("invalid_entry");
  const kind = r.category_kind ?? null;
  if (kind !== "expense" && kind !== "income" && kind !== null)
    throw new RuleError("invalid_category");
  const category = r.category_id ?? null;
  if (category !== null && typeof category !== "string") throw new RuleError("invalid_category");
  if (typeof r.account_id !== "string" || r.account_id === "")
    throw new RuleError("invalid_account");
  const id = r.id ?? null;
  if (id !== null && typeof id !== "string") throw new RuleError("invalid_entry");
  return {
    id,
    date,
    cents,
    direction: r.direction,
    is_transfer: r.is_transfer,
    category_id: category,
    category_kind: kind,
    account_id: r.account_id,
  };
}

function entries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_entries");
  return raw.map(entry);
}

function dayKey(d: Day): string {
  return iso(d);
}

export interface MonthTotals {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  net_cents: number;
  transfers_out_cents: number;
  count: number;
  by_category: Array<{ category_id: string | null; out_cents: number }>;
  by_account: Array<{ account_id: string; in_cents: number; out_cents: number }>;
}

export function monthTotals(asOf: unknown, rawEntries: unknown): MonthTotals {
  const [start, end] = monthBounds(parseDate(asOf));
  return totals(start, end, entries(rawEntries));
}

/** The same totals between two dates inclusive: the weekly recap's seven days (fast-follow 6). */
export function periodTotals(start: unknown, end: unknown, rawEntries: unknown): MonthTotals {
  const first = parseDate(start);
  const last = parseDate(end);
  if (dayKey(last) < dayKey(first)) throw new RuleError("invalid_range");
  return totals(first, last, entries(rawEntries));
}

export const STEPS = ["week", "month", "quarter"] as const;
export type Step = (typeof STEPS)[number];

export interface SeriesStep {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  net_cents: number;
  count: number;
}

export interface Series {
  start: string;
  end: string;
  step: Step;
  steps: SeriesStep[];
  in_cents: number;
  out_cents: number;
  net_cents: number;
  count: number;
  by_category: Array<{ category_id: string | null; out_cents: number }>;
  active_months: number;
  avg_in_cents: number | null;
  avg_out_cents: number | null;
  avg_net_cents: number | null;
  first_date: string | null;
}

/** Seven-day blocks from the start, or calendar months / quarters, each cut to the range. */
function stepBounds(start: Day, end: Day, step: Step): Array<[Day, Day]> {
  const out: Array<[Day, Day]> = [];
  const endKey = dayKey(end);
  if (step === "week") {
    let first = start;
    while (dayKey(first) <= endKey) {
      const six = addDays(first, 6);
      const last = dayKey(six) < endKey ? six : end;
      out.push([first, last]);
      first = addDays(last, 1);
    }
    return out;
  }
  const months = step === "month" ? 1 : 3;
  let first: Day = { y: start.y, m: start.m - ((start.m - 1) % months), d: 1 };
  while (dayKey(first) <= endKey) {
    const next = addMonths(first, months);
    const lastOf = addDays(next, -1);
    out.push([
      dayKey(first) > dayKey(start) ? first : start,
      dayKey(lastOf) < endKey ? lastOf : end,
    ]);
    first = next;
  }
  return out;
}

/** Range totals split into steps, with averages a month over months that have entries. */
export function series(start: unknown, end: unknown, step: unknown, rawEntries: unknown): Series {
  const first = parseDate(start);
  const last = parseDate(end);
  if (dayKey(last) < dayKey(first)) throw new RuleError("invalid_range");
  if (!(STEPS as readonly unknown[]).includes(step)) throw new RuleError("invalid_step");
  const parsed = entries(rawEntries);
  const whole = totals(first, last, parsed);
  const steps = stepBounds(first, last, step as Step).map(([a, b]) => {
    const t = totals(a, b, parsed);
    return {
      start: t.start,
      end: t.end,
      in_cents: t.in_cents,
      out_cents: t.out_cents,
      net_cents: t.net_cents,
      count: t.count,
    };
  });
  const firstKey = dayKey(first);
  const lastKey = dayKey(last);
  const active = new Set(
    parsed
      .filter((e) => !e.is_transfer && dayKey(e.date) >= firstKey && dayKey(e.date) <= lastKey)
      .map((e) => `${e.date.y}-${e.date.m}`),
  );
  const n = active.size;
  const avg = (cents: number) => (n ? roundDiv(cents, n) : null);
  const earliest = parsed.map((e) => dayKey(e.date)).sort()[0] ?? null;
  return {
    start: whole.start,
    end: whole.end,
    step: step as Step,
    steps,
    in_cents: whole.in_cents,
    out_cents: whole.out_cents,
    net_cents: whole.net_cents,
    count: whole.count,
    by_category: whole.by_category,
    active_months: n,
    avg_in_cents: avg(whole.in_cents),
    avg_out_cents: avg(whole.out_cents),
    avg_net_cents: avg(whole.net_cents),
    first_date: earliest,
  };
}

function totals(start: Day, end: Day, parsed: Entry[]): MonthTotals {
  const startKey = dayKey(start);
  const endKey = dayKey(end);
  const rows = parsed.filter((e) => {
    const k = dayKey(e.date);
    return k >= startKey && k <= endKey;
  });
  let inCents = 0;
  let outCents = 0;
  let transfersOut = 0;
  let count = 0;
  const byCategory = new Map<string | null, number>();
  const byAccount = new Map<string, { in_cents: number; out_cents: number }>();
  for (const e of rows) {
    let account = byAccount.get(e.account_id);
    if (!account) {
      account = { in_cents: 0, out_cents: 0 };
      byAccount.set(e.account_id, account);
    }
    if (e.is_transfer) {
      if (e.direction === "out") transfersOut += e.cents;
      continue;
    }
    count += 1;
    if (e.direction === "out") {
      outCents += e.cents;
      account.out_cents += e.cents;
      byCategory.set(e.category_id, (byCategory.get(e.category_id) ?? 0) + e.cents);
    } else if (e.category_kind === "expense") {
      outCents -= e.cents;
      account.out_cents -= e.cents;
      byCategory.set(e.category_id, (byCategory.get(e.category_id) ?? 0) - e.cents);
    } else {
      inCents += e.cents;
      account.in_cents += e.cents;
    }
  }
  const categories = [...byCategory.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    if ((a[0] === null) !== (b[0] === null)) return a[0] === null ? 1 : -1;
    return compareText(a[0] ?? "", b[0] ?? "");
  });
  const accounts = [...byAccount.entries()].sort((a, b) => compareText(a[0], b[0]));
  return {
    start: startKey,
    end: endKey,
    in_cents: inCents,
    out_cents: outCents,
    net_cents: inCents - outCents,
    transfers_out_cents: transfersOut,
    count,
    by_category: categories.map(([category_id, out_cents]) => ({ category_id, out_cents })),
    by_account: accounts.map(([account_id, v]) => ({ account_id, ...v })),
  };
}

export function netChange(netCents: unknown, previousNetCents: unknown): number {
  return assertInt(netCents) - assertInt(previousNetCents);
}

export interface TransferPair {
  out_id: string;
  in_id: string;
  days_apart: number;
}

export function matchTransfers(rawEntries: unknown, windowDays: unknown = 5): TransferPair[] {
  const window = assertInt(windowDays);
  if (window < 0) throw new RuleError("invalid_window");
  const rows = entries(rawEntries).filter((e) => !e.is_transfer);
  if (rows.some((e) => e.id === null)) throw new RuleError("invalid_entry");
  const byDateThenId = (a: Entry, b: Entry) =>
    compareText(dayKey(a.date), dayKey(b.date)) || compareText(a.id as string, b.id as string);
  const outs = rows.filter((e) => e.direction === "out").sort(byDateThenId);
  const ins = rows.filter((e) => e.direction === "in").sort(byDateThenId);
  const used = new Set<string>();
  const pairs: TransferPair[] = [];
  for (const o of outs) {
    let best: Entry | null = null;
    let bestKey: [number, string, string] | null = null;
    for (const i of ins) {
      if (used.has(i.id as string) || i.account_id === o.account_id || i.cents !== o.cents)
        continue;
      const gap = Math.abs(daysUntil(o.date, i.date));
      if (gap > window) continue;
      const key: [number, string, string] = [gap, dayKey(i.date), i.id as string];
      // Python's tuple order: the gap, then the date, then the id by code point (invariant 10).
      if (
        bestKey === null ||
        (key[0] - bestKey[0] ||
          compareText(key[1], bestKey[1]) ||
          compareText(key[2], bestKey[2])) < 0
      ) {
        best = i;
        bestKey = key;
      }
    }
    if (best && bestKey) {
      used.add(best.id as string);
      pairs.push({ out_id: o.id as string, in_id: best.id as string, days_apart: bestKey[0] });
    }
  }
  return pairs;
}

const BUCKETS = ["need", "want", "save", null] as const;
type Bucket = "need" | "want" | "save" | null;
type BucketTotals = { need: number; want: number; save: number; none: number };

export interface FixedFlexibleCategory {
  category_id: string | null;
  bucket: Bucket;
  fixed_cents: number;
  flexible_cents: number;
  out_cents: number;
}

export interface FixedFlexible {
  start: string;
  end: string;
  in_cents: number;
  out_cents: number;
  fixed_cents: number;
  flexible_cents: number;
  fixed_by_bucket: BucketTotals;
  flexible_by_bucket: BucketTotals;
  kept_cents: number;
  kept_rate_bps: number | null;
  by_category: FixedFlexibleCategory[];
  room: Array<{ category_id: string | null; flexible_cents: number }>;
}

/** Python's (−cents, category is None, category or "") order, in code points. */
function byCentsThenCategory(
  a: { category_id: string | null },
  b: { category_id: string | null },
  ca: number,
  cb: number,
): number {
  if (ca !== cb) return cb - ca;
  if ((a.category_id === null) !== (b.category_id === null)) return a.category_id === null ? 1 : -1;
  return compareText(a.category_id ?? "", b.category_id ?? "");
}

/** Port of cashflow.fixed_flexible: fixed vs flexible money out and the kept rate. */
export function fixedFlexible(start: unknown, end: unknown, rawEntries: unknown): FixedFlexible {
  const first = parseDate(start);
  const last = parseDate(end);
  if (daysUntil(first, last) < 0) throw new RuleError("invalid_range");
  if (!Array.isArray(rawEntries)) throw new RuleError("invalid_entries");
  const parsed = rawEntries.map((raw) => {
    const e = entry(raw);
    const r = raw as Record<string, unknown>;
    if (typeof r.is_recurring !== "boolean") throw new RuleError("invalid_entry");
    const bucket = r.bucket ?? null;
    if (!(BUCKETS as readonly unknown[]).includes(bucket)) throw new RuleError("invalid_bucket");
    return { ...e, is_recurring: r.is_recurring, bucket: bucket as Bucket };
  });
  const rows = parsed.filter((e) => daysUntil(first, e.date) >= 0 && daysUntil(e.date, last) >= 0);
  let inCents = 0;
  const parts: Record<"fixed" | "flexible", BucketTotals> = {
    fixed: { need: 0, want: 0, save: 0, none: 0 },
    flexible: { need: 0, want: 0, save: 0, none: 0 },
  };
  const byCategory = new Map<string | null, FixedFlexibleCategory>();
  for (const e of rows) {
    if (e.is_transfer) continue;
    if (e.direction === "in" && e.category_kind !== "expense") {
      inCents += e.cents;
      continue;
    }
    // money out, or a refund netting against it
    const cents = e.direction === "out" ? e.cents : -e.cents;
    const part = e.is_recurring ? "fixed" : "flexible";
    parts[part][e.bucket ?? "none"] += cents;
    let cat = byCategory.get(e.category_id);
    if (!cat) {
      cat = {
        category_id: e.category_id,
        bucket: e.bucket,
        fixed_cents: 0,
        flexible_cents: 0,
        out_cents: 0,
      };
      byCategory.set(e.category_id, cat);
    }
    if (cat.bucket !== e.bucket) throw new RuleError("invalid_bucket");
    if (part === "fixed") cat.fixed_cents += cents;
    else cat.flexible_cents += cents;
  }
  const sum = (b: BucketTotals) => b.need + b.want + b.save + b.none;
  const fixed = sum(parts.fixed);
  const flexible = sum(parts.flexible);
  const kept = inCents - fixed - flexible;
  const categories = [...byCategory.values()].map((c) => ({
    ...c,
    out_cents: c.fixed_cents + c.flexible_cents,
  }));
  categories.sort((a, b) => byCentsThenCategory(a, b, a.out_cents, b.out_cents));
  const room = categories
    .filter((c) => c.bucket === "want" && c.flexible_cents > 0)
    .map((c) => ({ category_id: c.category_id, flexible_cents: c.flexible_cents }));
  room.sort((a, b) => byCentsThenCategory(a, b, a.flexible_cents, b.flexible_cents));
  return {
    start: iso(first),
    end: iso(last),
    in_cents: inCents,
    out_cents: fixed + flexible,
    fixed_cents: fixed,
    flexible_cents: flexible,
    fixed_by_bucket: parts.fixed,
    flexible_by_bucket: parts.flexible,
    kept_cents: kept,
    kept_rate_bps: inCents ? ratioBps(kept, inCents) : null,
    by_category: categories,
    room,
  };
}
