/** Port of stackd_rules/budget.py: 50/30/20 targets, monthly take-home, and the budget summary. */

import { type Day, iso, monthBounds, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { allocate, assertInt, mul, roundDiv } from "./money.ts";
import { compareText } from "./text.ts";

export type Bucket = "need" | "want" | "save";
const BUCKETS: Bucket[] = ["need", "want", "save"];
const METHODS = ["50_30_20", "zero_based"];
const FREQUENCIES: Record<string, [number, number]> = {
  weekly: [52, 12],
  biweekly: [26, 12],
  semimonthly: [2, 1],
  monthly: [1, 1],
};
const WEIGHTS_BPS = [5000, 3000, 2000];

export function targets503020(takeHomeCents: unknown): Record<Bucket, number> {
  const total = assertInt(takeHomeCents);
  if (total < 0) throw new RuleError("invalid_amount");
  const [need, want, save] = allocate(total, WEIGHTS_BPS, 2) as [number, number, number];
  return { need, want, save };
}

/** Port of budget.targets_split: the person's own needs / wants / save split. */
export function targetsSplit(takeHomeCents: unknown, splitBps: unknown): Record<Bucket, number> {
  const total = assertInt(takeHomeCents);
  if (total < 0) throw new RuleError("invalid_amount");
  const [need, want, save] = allocate(total, splitWeights(splitBps), 2) as [number, number, number];
  return { need, want, save };
}

function splitWeights(splitBps: unknown): number[] {
  if (splitBps === null || typeof splitBps !== "object" || Array.isArray(splitBps))
    throw new RuleError("invalid_split");
  const row = splitBps as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== BUCKETS.length || !BUCKETS.every((b) => keys.includes(b)))
    throw new RuleError("invalid_split");
  const weights = BUCKETS.map((b) => row[b]);
  if (weights.some((w) => typeof w !== "number" || !Number.isInteger(w) || w < 0 || w > 10000))
    throw new RuleError("invalid_split");
  if ((weights as number[]).reduce((a, b) => a + b, 0) !== 10000)
    throw new RuleError("invalid_split");
  return weights as number[];
}

export function monthlyTakeHome(amountCents: unknown, frequency: unknown): number {
  const amount = assertInt(amountCents);
  if (amount < 0) throw new RuleError("invalid_amount");
  if (typeof frequency !== "string" || !(frequency in FREQUENCIES))
    throw new RuleError("invalid_frequency");
  const [perYear, per] = FREQUENCIES[frequency] as [number, number];
  return roundDiv(mul(amount, perYear), per);
}

function bucketOf(value: unknown): Bucket | null {
  if (value === null || value === undefined) return null;
  if (!BUCKETS.includes(value as Bucket)) throw new RuleError("invalid_bucket");
  return value as Bucket;
}

interface Row {
  cents: number;
  direction: "in" | "out";
  category_id: string | null;
  bucket: Bucket | null;
}

function dayKey(d: Day): string {
  return iso(d);
}

function entries(raw: unknown, start: Day, end: Day, asOf: Day): Row[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_entries");
  const s = dayKey(start);
  const e = dayKey(end);
  const a = dayKey(asOf);
  const rows: Row[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new RuleError("invalid_entry");
    const r = item as Record<string, unknown>;
    const day = dayKey(parseDate(r.date));
    const cents = assertInt(r.amount_cents);
    if (cents < 0) throw new RuleError("invalid_amount");
    if (r.direction !== "in" && r.direction !== "out") throw new RuleError("invalid_direction");
    if (typeof r.is_transfer !== "boolean") throw new RuleError("invalid_entry");
    const category = r.category_id ?? null;
    if (category !== null && typeof category !== "string") throw new RuleError("invalid_category");
    const bucket = bucketOf(r.bucket);
    if (day < s || day > e || day > a || r.is_transfer) continue;
    rows.push({ cents, direction: r.direction, category_id: category, bucket });
  }
  return rows;
}

interface Line {
  category_id: string;
  bucket: Bucket | null;
  planned_cents: number;
}

function lines(raw: unknown): Line[] {
  if (!Array.isArray(raw)) throw new RuleError("invalid_lines");
  const out: Line[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Line).category_id !== "string"
    ) {
      throw new RuleError("invalid_line");
    }
    const l = item as Record<string, unknown>;
    const planned = assertInt(l.planned_cents);
    if (planned < 0) throw new RuleError("invalid_amount");
    const id = l.category_id as string;
    if (seen.has(id)) throw new RuleError("duplicate_line");
    seen.add(id);
    out.push({ category_id: id, bucket: bucketOf(l.bucket), planned_cents: planned });
  }
  return out;
}

export interface BudgetSummary {
  start: string;
  end: string;
  method: string;
  take_home_cents: number;
  buckets: Array<{
    bucket: Bucket;
    planned_cents: number;
    spent_cents: number;
    left_cents: number;
  }>;
  categories: Array<{
    category_id: string;
    bucket: Bucket | null;
    planned_cents: number | null;
    spent_cents: number;
  }>;
  uncategorized_cents: number;
  total_spent_cents: number;
  left_to_assign_cents: number | null;
  kept_cents: number;
}

export function summary(
  asOf: unknown,
  method: unknown,
  takeHomeCents: unknown,
  rawLines: unknown,
  rawEntries: unknown,
  splitBps: unknown = null,
): BudgetSummary {
  if (typeof method !== "string" || !METHODS.includes(method))
    throw new RuleError("invalid_method");
  const takeHome = assertInt(takeHomeCents);
  if (takeHome < 0) throw new RuleError("invalid_amount");
  const day = parseDate(asOf);
  const [start, end] = monthBounds(day);
  const plannedLines = lines(rawLines);
  const rows = entries(rawEntries, start, end, day);

  const spentByCategory = new Map<string, number>();
  const bucketByCategory = new Map<string, Bucket | null>();
  for (const l of plannedLines) bucketByCategory.set(l.category_id, l.bucket);
  let uncategorized = 0;
  for (const r of rows) {
    const signed = r.direction === "out" ? r.cents : -r.cents;
    if (r.direction === "in" && r.bucket === null) continue;
    if (r.category_id === null) {
      uncategorized += signed;
      continue;
    }
    spentByCategory.set(r.category_id, (spentByCategory.get(r.category_id) ?? 0) + signed);
    if (!bucketByCategory.has(r.category_id)) bucketByCategory.set(r.category_id, r.bucket);
  }

  let plannedByBucket: Record<Bucket, number>;
  let leftToAssign: number | null;
  if (method === "50_30_20") {
    plannedByBucket =
      splitBps === null || splitBps === undefined
        ? targets503020(takeHome)
        : targetsSplit(takeHome, splitBps);
    leftToAssign = null;
  } else {
    plannedByBucket = { need: 0, want: 0, save: 0 };
    for (const l of plannedLines)
      if (l.bucket !== null) plannedByBucket[l.bucket] += l.planned_cents;
    leftToAssign = takeHome - plannedLines.reduce((sum, l) => sum + l.planned_cents, 0);
  }
  const spentByBucket: Record<Bucket, number> = { need: 0, want: 0, save: 0 };
  for (const [category, cents] of spentByCategory) {
    const bucket = bucketByCategory.get(category) ?? null;
    if (bucket !== null) spentByBucket[bucket] += cents;
  }
  const plannedLookup = new Map(plannedLines.map((l) => [l.category_id, l.planned_cents]));
  const categoryIds = [...new Set([...spentByCategory.keys(), ...plannedLookup.keys()])].sort(
    (a, b) => {
      const sa = spentByCategory.get(a) ?? 0;
      const sb = spentByCategory.get(b) ?? 0;
      if (sa !== sb) return sb - sa;
      return compareText(a, b);
    },
  );
  let totalSpent = uncategorized;
  for (const v of spentByCategory.values()) totalSpent += v;
  return {
    start: dayKey(start),
    end: dayKey(end),
    method,
    take_home_cents: takeHome,
    buckets: BUCKETS.map((b) => ({
      bucket: b,
      planned_cents: plannedByBucket[b],
      spent_cents: spentByBucket[b],
      left_cents: plannedByBucket[b] - spentByBucket[b],
    })),
    categories: categoryIds.map((c) => ({
      category_id: c,
      bucket: bucketByCategory.get(c) ?? null,
      planned_cents: method === "zero_based" ? (plannedLookup.get(c) ?? null) : null,
      spent_cents: spentByCategory.get(c) ?? 0,
    })),
    uncategorized_cents: uncategorized,
    total_spent_cents: totalSpent,
    left_to_assign_cents: leftToAssign,
    kept_cents: Math.max(0, takeHome - totalSpent),
  };
}
