import type { Entry, StackdDb } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";

/**
 * Search over the person's own data (owner decision, November 16, 2026): merchants, entries,
 * jars and goals, bills, tags and accounts, read from this device's database only. Nothing typed
 * or found is sent anywhere or kept; a result opens the person's own screen for it.
 *
 * Words match anywhere in a name, note or tag ("bucks" finds STARBUCKS), every word typed must
 * match, case doesn't matter. A typed amount ("84.20", "$84") also finds entries of exactly that
 * amount. Orders are fixed: newest first, then by id.
 */

export interface DataHit {
  /** Stable within one search: kind and id. */
  key: string;
  kind: "merchant" | "entry" | "goal" | "bill" | "tag" | "account";
  label: string;
  /** Where it lives and one short fact. */
  detail: string;
  path: string;
  /** Navigation state: what the full-list screen shows, never in the address. */
  state?: { match: MatchSpec; title: string };
}

/** What the full list behind "See all" matches: words, an amount, or one merchant. */
export interface MatchSpec {
  words: string[];
  cents: number | null;
  merchant?: string;
}

export interface DataResults {
  sections: { title: string; hits: DataHit[]; more: number; all?: DataHit }[];
}

/** Results shown per section; the rest are counted, and entries have See all. */
export const PER_SECTION = 4;

export const normWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9#&'.-]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);

const plain = (s: string) => s.toLowerCase();

function hasAll(text: string, words: string[]): boolean {
  const t = plain(text);
  return words.every((w) => t.includes(w));
}

/** "84.20", "$84", "1,250.00": an amount typed on its own. */
const AMOUNT = /^\$?\s?[0-9][0-9,]*(\.[0-9]{1,2})?$/;

async function typedAmount(query: string): Promise<number | null> {
  const q = query.trim();
  if (!AMOUNT.test(q)) return null;
  try {
    const cents = await parseAmount(q.replace(/^\$\s?/, ""));
    return cents > 0 ? cents : null;
  } catch {
    return null;
  }
}

/** The name people see for an entry's merchant, and the key that groups them. */
export const merchantKey = (e: Entry) => plain(e.merchant).replace(/\s+/g, " ").trim();

/** Whether an entry matches a spec (shared by the sheet and the full list). */
export function entryMatches(e: Entry, spec: MatchSpec): boolean {
  if (spec.merchant !== undefined) return merchantKey(e) === spec.merchant;
  if (spec.cents !== null && e.amount_cents === spec.cents) return true;
  if (spec.words.length === 0) return false;
  const text = `${e.merchant} ${e.clean_description} ${e.note ?? ""} ${(e.tags ?? []).map((t) => `#${t} ${t}`).join(" ")}`;
  return hasAll(text, spec.words);
}

const newestFirst = (a: Entry, b: Entry) => compareText(b.date, a.date) || compareText(a.id, b.id);

export async function matchSpec(query: string): Promise<MatchSpec | null> {
  const words = normWords(query);
  const cents = await typedAmount(query);
  if (cents === null && (words.length === 0 || words.join("").length < 2)) return null;
  return { words: cents === null ? words : [], cents };
}

export async function searchData(
  db: StackdDb,
  query: string,
  fmt: { money: (cents: number, direction?: "in" | "out") => string; day: (iso: string) => string },
): Promise<DataResults> {
  const spec = await matchSpec(query);
  if (!spec) return { sections: [] };
  const words = spec.words;

  const entries = (await db.entries.filter((e) => entryMatches(e, spec)).toArray()).sort(
    newestFirst,
  );

  // Merchants: words only, grouped by the name people see; newest first.
  const merchants: DataHit[] = [];
  if (words.length) {
    const seen = new Map<string, { name: string; count: number; last: string }>();
    for (const e of entries) {
      if (!hasAll(e.merchant, words)) continue;
      const key = merchantKey(e);
      const m = seen.get(key);
      if (m) m.count += 1;
      else seen.set(key, { name: e.merchant, count: 1, last: e.date });
    }
    for (const [key, m] of seen)
      merchants.push({
        key: `merchant:${key}`,
        kind: "merchant",
        label: m.name,
        detail: `Merchant · ${m.count} ${m.count === 1 ? "entry" : "entries"} · last ${fmt.day(m.last)}`,
        path: "/search/entries",
        state: { match: { words: [], cents: null, merchant: key }, title: m.name },
      });
  }

  const entryHits: DataHit[] = entries.map((e) => ({
    key: `entry:${e.id}`,
    kind: "entry",
    label: e.merchant,
    detail: `Entry · ${fmt.money(e.amount_cents, e.direction)} · ${fmt.day(e.date)}`,
    path: `/entries/${e.id}`,
  }));

  const goals: DataHit[] = words.length
    ? (await db.goals.toArray())
        .filter((g) => g.status !== "archived" && hasAll(`${g.title} ${g.label ?? ""}`, words))
        .sort(
          (a, b) =>
            compareText(a.title.toLowerCase(), b.title.toLowerCase()) || compareText(a.id, b.id),
        )
        .map((g) => ({
          key: `goal:${g.id}`,
          kind: "goal",
          label: g.title,
          detail: g.group_id ? "Challenge jar" : "Jar or goal",
          path: `/goals/${g.id}`,
        }))
    : [];

  const bills: DataHit[] = words.length
    ? (await db.recurring_series.where("status").equals("confirmed").toArray())
        .filter((s) => hasAll(`${s.label} ${s.payee}`, words))
        .sort(
          (a, b) =>
            compareText(a.label.toLowerCase(), b.label.toLowerCase()) || compareText(a.id, b.id),
        )
        .map((s) => ({
          key: `bill:${s.id}`,
          kind: "bill",
          label: s.label,
          detail: `${s.kind === "income" ? "Income" : "Bill"} · ${fmt.money(s.expected_cents)} · next ${fmt.day(s.next_date)}`,
          path: "/bills",
        }))
    : [];

  const tagCounts = new Map<string, number>();
  if (words.length)
    for (const e of await db.entries.toArray())
      for (const t of e.tags ?? [])
        if (
          hasAll(
            t,
            words.map((w) => w.replace(/^#/, "")),
          )
        )
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const tags: DataHit[] = [...tagCounts]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([t, n]) => ({
      key: `tag:${t}`,
      kind: "tag",
      label: `#${t}`,
      detail: `Tag · ${n} ${n === 1 ? "entry" : "entries"}`,
      path: `/tags/${encodeURIComponent(t)}`,
    }));

  const accounts: DataHit[] = words.length
    ? (await db.accounts.toArray())
        .filter((a) => hasAll(a.label, words))
        .sort(
          (a, b) =>
            compareText(a.label.toLowerCase(), b.label.toLowerCase()) || compareText(a.id, b.id),
        )
        .map((a) => ({
          key: `account:${a.id}`,
          kind: "account",
          label: a.label,
          detail: "Account",
          path: "/me/accounts",
        }))
    : [];

  const section = (title: string, hits: DataHit[], all?: DataHit) => ({
    title,
    hits: hits.slice(0, PER_SECTION),
    more: Math.max(0, hits.length - PER_SECTION),
    all,
  });
  const allEntries: DataHit | undefined =
    entryHits.length > PER_SECTION
      ? {
          key: "entries:all",
          kind: "entry",
          label: `See all ${entryHits.length} entries`,
          detail: "With what they add up to",
          path: "/search/entries",
          state: {
            match: spec,
            title: spec.cents !== null ? fmt.money(spec.cents) : `“${query.trim()}”`,
          },
        }
      : undefined;
  return {
    sections: [
      section("Merchants", merchants),
      section("Entries", entryHits, allEntries),
      section("Jars & goals", goals),
      section("Bills", bills),
      section("Tags", tags),
      section("Accounts", accounts),
    ].filter((s) => s.hits.length),
  };
}
