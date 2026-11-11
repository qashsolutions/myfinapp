import { parseAmount, type SplitMethod, splitShare } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";

/** Typed per-person values → the rule's units: exact cents, percent bps, whole shares. */
export async function valuesOf(
  method: SplitMethod,
  people: string[],
  typed: Record<string, string>,
): Promise<Record<string, number> | null | "bad"> {
  if (method === "equal") return null;
  const out: Record<string, number> = {};
  for (const p of people) {
    const text = typed[p] ?? "";
    if (method === "shares") {
      const n = parseWholeNumber(text, 1, 1000);
      if (n === null) return "bad";
      out[p] = n;
    } else {
      // "$12.50" → 1250 cents; "33.33" percent → 3333 basis points (both two places).
      try {
        out[p] = await parseAmount(text.replace("%", ""));
      } catch {
        return "bad";
      }
    }
  }
  return out;
}

/**
 * What each way of splitting means, under the choices (owner, November 11, 2026: "how would a
 * user know which one to use?").
 */
export const METHOD_HELP: Record<SplitMethod, string> = {
  equal: "Everyone ticked pays the same.",
  exact: "Type each person's dollars. They add up to the total.",
  percent: "Type each person's percent. They add up to 100%.",
  shares: "Type a whole number each. 2 pays twice what 1 does.",
};

/** A typed value as the box shows it: cents or basis points to "33.33", shares as is. */
function shown(method: SplitMethod, n: number): string {
  return method === "shares" ? String(n) : (n / 100).toFixed(2);
}

/**
 * An even start for the boxes, so nobody faces empty ones: exact splits the amount equally
 * (nothing until there is an amount), percent splits 100% equally, shares are 1 each. The odd
 * cent or hundredth of a percent goes to `leftoverTo` when they're in, else the first person,
 * through the engine like every split.
 */
export async function evenValues(
  method: SplitMethod,
  people: string[],
  amountCents: number | null,
  leftoverTo: string,
): Promise<Record<string, string>> {
  if (method === "equal" || people.length === 0) return {};
  if (method === "shares") return Object.fromEntries(people.map((p) => [p, "1"]));
  const whole = method === "percent" ? 10000 : amountCents;
  if (whole === null || whole <= 0) return {};
  const lead = people.includes(leftoverTo) ? leftoverTo : (people[0] as string);
  const { parts } = await splitShare(whole, "equal", people, lead);
  return Object.fromEntries(parts.map((x) => [x.person, shown(method, x.cents)]));
}

/** "80%" or "33.34%" from basis points. */
function percentText(bps: number): string {
  return bps % 100 === 0 ? `${bps / 100}%` : `${(bps / 100).toFixed(2)}%`;
}

/**
 * The running total under the people: "Adds up to $80.00 of $90.00 · $10.00 left", green once
 * it's right. Null for Equally. Boxes that can't be read yet count as nothing.
 */
export async function totalOf(
  method: SplitMethod,
  people: string[],
  typed: Record<string, string>,
  amountCents: number | null,
): Promise<{ text: string; ok: boolean } | null> {
  if (method === "equal" || people.length === 0) return null;
  let sum = 0;
  let unread = false;
  for (const p of people) {
    const one = await valuesOf(method, [p], typed);
    if (one === "bad" || one === null) unread = true;
    else sum += one[p] ?? 0;
  }
  if (method === "shares") {
    return {
      text: `${sum} ${sum === 1 ? "share" : "shares"} in all${unread ? " · fill in everyone" : ""}`,
      ok: !unread && sum > 0,
    };
  }
  if (method === "percent") {
    const off = 10000 - sum;
    const tail =
      off === 0 ? "" : off > 0 ? ` · ${percentText(off)} left` : ` · ${percentText(-off)} too much`;
    return { text: `Adds up to ${percentText(sum)} of 100%${tail}`, ok: off === 0 && !unread };
  }
  if (amountCents === null || amountCents <= 0)
    return { text: `Adds up to ${formatCents(sum)}`, ok: false };
  const off = amountCents - sum;
  const tail =
    off === 0 ? "" : off > 0 ? ` · ${formatCents(off)} left` : ` · ${formatCents(-off)} too much`;
  return {
    text: `Adds up to ${formatCents(sum)} of ${formatCents(amountCents)}${tail}`,
    ok: off === 0 && !unread,
  };
}
