/** Port of stackd_rules/splits.py: one bill's parts, group balances, fewest payments, repeats. */

import { daysUntil, iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt, mul, safeNumber } from "./money.ts";
import { stepKeepingDay } from "./recurring.ts";
import { compareText } from "./text.ts";

export const METHODS = ["equal", "exact", "percent", "shares"] as const;
export const REPEATS = ["weekly", "monthly", "yearly"] as const;
const MAX_REPEAT_DATES = 400;

export interface Part {
  person: string;
  cents: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function people(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new RuleError("no_people");
  const ids: string[] = [];
  for (const p of value) {
    if (typeof p !== "string" || p === "" || ids.includes(p)) throw new RuleError("invalid_people");
    ids.push(p);
  }
  return ids;
}

function values(value: unknown, ids: string[]): Map<string, number> {
  if (!isRecord(value)) throw new RuleError("values_must_match_people");
  const keys = Object.keys(value);
  if (keys.length !== ids.length || !ids.every((p) => Object.hasOwn(value, p)))
    throw new RuleError("values_must_match_people");
  const out = new Map(ids.map((p) => [p, assertInt(value[p], "invalid_share")]));
  for (const v of out.values()) if (v < 0) throw new RuleError("invalid_share");
  return out;
}

export function share(
  amountCents: unknown,
  method: unknown,
  peopleIn: unknown,
  leftoverTo: unknown,
  valuesIn: unknown = null,
): { parts: Part[]; total_cents: number } {
  const amount = assertInt(amountCents, "invalid_amount");
  if (amount <= 0) throw new RuleError("invalid_amount");
  if (!(METHODS as readonly unknown[]).includes(method)) throw new RuleError("invalid_method");
  const ids = people(peopleIn);
  if (typeof leftoverTo !== "string" || !ids.includes(leftoverTo))
    throw new RuleError("leftover_to_not_in_split");
  let weights: Map<string, number>;
  if (method === "equal") {
    if (valuesIn !== null && valuesIn !== undefined) throw new RuleError("values_not_used");
    weights = new Map(ids.map((p) => [p, 1]));
  } else {
    weights = values(valuesIn, ids);
  }
  let sum = 0;
  for (const w of weights.values()) sum += w;
  let parts: Map<string, number>;
  if (method === "exact") {
    if (sum !== amount) throw new RuleError("parts_do_not_add_up");
    parts = new Map(weights);
  } else {
    if (method === "percent" && sum !== 10000) throw new RuleError("percent_must_sum_to_10000");
    if (method === "shares" && [...weights.values()].some((w) => w === 0))
      throw new RuleError("invalid_share");
    const total = BigInt(sum);
    parts = new Map(ids.map((p) => [p, safeNumber(mul(amount, weights.get(p) ?? 0) / total)]));
    let given = 0;
    for (const c of parts.values()) given += c;
    parts.set(leftoverTo, (parts.get(leftoverTo) ?? 0) + amount - given);
  }
  return {
    parts: ids.map((p) => ({ person: p, cents: parts.get(p) ?? 0 })),
    total_cents: amount,
  };
}

/** A bill split by item (chunk S.8): see services/rules/stackd_rules/splits.py `itemize`. */
export function itemize(
  itemsIn: unknown,
  extrasCents: unknown,
  leftoverTo: unknown,
): { parts: Part[]; items_cents: number; extras_cents: number; total_cents: number } {
  if (!Array.isArray(itemsIn) || itemsIn.length === 0) throw new RuleError("no_items");
  const extras = assertInt(extrasCents, "invalid_extras");
  if (extras < 0) throw new RuleError("invalid_extras");
  const order: string[] = [];
  const subtotal = new Map<string, number>();
  for (const item of itemsIn) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new RuleError("invalid_amount");
    const x = item as { cents?: unknown; people?: unknown };
    const cents = assertInt(x.cents, "invalid_amount");
    if (cents <= 0) throw new RuleError("invalid_amount");
    const ids = people(x.people);
    for (const p of ids)
      if (!subtotal.has(p)) {
        order.push(p);
        subtotal.set(p, 0);
      }
    const each = Math.floor(cents / ids.length);
    for (const p of ids) subtotal.set(p, (subtotal.get(p) ?? 0) + each);
    const takes = typeof leftoverTo === "string" && ids.includes(leftoverTo) ? leftoverTo : ids[0];
    if (takes !== undefined)
      subtotal.set(takes, (subtotal.get(takes) ?? 0) + cents - each * ids.length);
  }
  if (typeof leftoverTo !== "string" || !subtotal.has(leftoverTo))
    throw new RuleError("leftover_to_not_in_split");
  let itemsTotal = 0;
  for (const c of subtotal.values()) itemsTotal += c;
  const total = BigInt(itemsTotal);
  const parts = new Map(
    order.map((p) => {
      const mine = subtotal.get(p) ?? 0;
      return [p, mine + safeNumber(mul(extras, mine) / total)];
    }),
  );
  let given = 0;
  for (const c of parts.values()) given += c;
  parts.set(leftoverTo, (parts.get(leftoverTo) ?? 0) + itemsTotal + extras - given);
  return {
    parts: order.map((p) => ({ person: p, cents: parts.get(p) ?? 0 })),
    items_cents: itemsTotal,
    extras_cents: extras,
    total_cents: assertInt(itemsTotal + extras, "too_large"),
  };
}

export function balances(
  peopleIn: unknown,
  bills: unknown,
  settlements: unknown,
): { balances: Part[]; on_hold: string[] } {
  const ids = people(peopleIn);
  const totals = new Map(ids.map((p) => [p, 0]));
  if (!Array.isArray(bills)) throw new RuleError("invalid_bills");
  const seen = new Set<string>();
  const onHold: string[] = [];
  for (const b of bills) {
    if (!isRecord(b) || typeof b.id !== "string" || b.id === "")
      throw new RuleError("invalid_bill");
    if (seen.has(b.id)) throw new RuleError("duplicate_bill");
    seen.add(b.id);
    const amount = assertInt(b.amount_cents, "invalid_amount");
    if (amount <= 0) throw new RuleError("invalid_amount");
    const payer = b.paid_by;
    if (typeof payer !== "string" || !totals.has(payer)) throw new RuleError("unknown_person");
    if (!Array.isArray(b.parts) || b.parts.length === 0) throw new RuleError("invalid_bill");
    const owed: [string, number][] = [];
    for (const part of b.parts) {
      if (!isRecord(part)) throw new RuleError("invalid_bill");
      if (typeof part.person !== "string" || !totals.has(part.person))
        throw new RuleError("unknown_person");
      const cents = assertInt(part.cents, "invalid_amount");
      if (cents < 0) throw new RuleError("invalid_amount");
      owed.push([part.person, cents]);
    }
    let sum = 0;
    for (const [, c] of owed) sum += c;
    if (sum !== amount) throw new RuleError("parts_do_not_add_up");
    if (typeof b.disputed !== "boolean") throw new RuleError("invalid_bill");
    if (b.disputed) {
      onHold.push(b.id);
      continue;
    }
    totals.set(payer, (totals.get(payer) ?? 0) + amount);
    for (const [person, cents] of owed) totals.set(person, (totals.get(person) ?? 0) - cents);
  }
  if (!Array.isArray(settlements)) throw new RuleError("invalid_settlements");
  for (const s of settlements) {
    if (!isRecord(s)) throw new RuleError("invalid_settlement");
    const sender = s.from;
    const receiver = s.to;
    if (
      typeof sender !== "string" ||
      typeof receiver !== "string" ||
      !totals.has(sender) ||
      !totals.has(receiver)
    )
      throw new RuleError("unknown_person");
    if (sender === receiver) throw new RuleError("invalid_settlement");
    const cents = assertInt(s.cents, "invalid_amount");
    if (cents <= 0) throw new RuleError("invalid_amount");
    totals.set(sender, (totals.get(sender) ?? 0) + cents);
    totals.set(receiver, (totals.get(receiver) ?? 0) - cents);
  }
  return {
    balances: ids.map((p) => ({ person: p, cents: totals.get(p) ?? 0 })),
    on_hold: onHold,
  };
}

/** Largest amount first, then the person id in code-point order (as Python compares str). */
function largest(side: Map<string, number>): string {
  let best: string | null = null;
  for (const [p, c] of side) {
    if (best === null) {
      best = p;
      continue;
    }
    const bc = side.get(best) ?? 0;
    if (c > bc || (c === bc && compareText(p, best) < 0)) best = p;
  }
  return best as string;
}

export function simplify(balancesIn: unknown): {
  payments: { from: string; to: string; cents: number }[];
} {
  if (!Array.isArray(balancesIn)) throw new RuleError("invalid_balances");
  const owe = new Map<string, number>();
  const owed = new Map<string, number>();
  const seen = new Set<string>();
  let total = 0;
  for (const b of balancesIn) {
    if (!isRecord(b) || typeof b.person !== "string" || b.person === "")
      throw new RuleError("invalid_people");
    if (seen.has(b.person)) throw new RuleError("invalid_people");
    seen.add(b.person);
    const cents = assertInt(b.cents, "invalid_amount");
    total += cents;
    if (cents < 0) owe.set(b.person, -cents);
    else if (cents > 0) owed.set(b.person, cents);
  }
  if (total !== 0) throw new RuleError("balances_do_not_sum_to_zero");
  const payments: { from: string; to: string; cents: number }[] = [];
  while (owe.size > 0) {
    const debtor = largest(owe);
    const creditor = largest(owed);
    const cents = Math.min(owe.get(debtor) ?? 0, owed.get(creditor) ?? 0);
    payments.push({ from: debtor, to: creditor, cents });
    for (const [side, person] of [
      [owe, debtor],
      [owed, creditor],
    ] as const) {
      const left = (side.get(person) ?? 0) - cents;
      if (left === 0) side.delete(person);
      else side.set(person, left);
    }
  }
  return { payments };
}

export function repeatDates(start: unknown, every: unknown, asOf: unknown): { dates: string[] } {
  const first = parseDate(start);
  const last = parseDate(asOf);
  if (!(REPEATS as readonly unknown[]).includes(every)) throw new RuleError("invalid_interval");
  const out: string[] = [];
  let day = first;
  while (daysUntil(day, last) >= 0) {
    if (out.length === MAX_REPEAT_DATES) throw new RuleError("too_many_dates");
    out.push(iso(day));
    day = stepKeepingDay(day, every, first.d);
  }
  return { dates: out };
}
