import { accessRoutes, mayOpen } from "../../app/AccessGate.tsx";
import type { Entitlements } from "../billing/entitlements.ts";
import { SEARCH_ENTRIES, type SearchEntry } from "./searchIndex.ts";

/**
 * Matching for search, on this device only: nothing typed is sent or stored. Deterministic: the
 * same words, plan and device give the same results in the same order (ties keep the index's
 * order; nothing here follows the phone's language).
 */

/** What a person may see: the access table every screen uses, their plan, and the platform. */
export interface SearchContext {
  entitlements: Pick<
    Entitlements,
    "access" | "bank_links_max" | "backup" | "household" | "groups_create"
  >;
  /** Installed (home screen or a store app): installing is done. */
  installed: boolean;
}

export interface SearchResult {
  entry: SearchEntry;
  /** The plan doesn't include it: the result opens the plans instead. */
  locked: boolean;
  /** Where picking it goes. */
  path: string;
}

export const PLAN_PATH = "/me/plan";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Edits between two short strings (insert, delete, change, swap two neighbours). */
export function editDistance(a: string, b: string): number {
  const w = b.length + 1;
  const d = new Array<number>((a.length + 1) * w).fill(0);
  const at = (i: number, j: number) => d[i * w + j] ?? 0;
  for (let i = 0; i <= a.length; i += 1) d[i * w] = i;
  for (let j = 0; j <= b.length; j += 1) d[j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, at(i - 2, j - 2) + 1);
      d[i * w + j] = best;
    }
  return at(a.length, b.length);
}

/**
 * How many typos a word may carry: none under 4 letters (so "bud" never brings up loose
 * matches), one from 4, two from 8. `wide` (the closest-match fallback) allows one more from 5.
 */
function allowed(term: string, wide: boolean): number {
  const n = term.length;
  if (n < 4) return 0;
  const base = n >= 8 ? 2 : 1;
  return wide && n >= 5 ? base + 1 : base;
}

function nearWord(term: string, word: string, wide: boolean): boolean {
  const max = allowed(term, wide);
  if (max === 0 || word.length < 3) return false;
  // Typing is usually part-way through a word: compare with its start too.
  const start = word.slice(0, term.length);
  return Math.min(editDistance(term, word), editDistance(term, start)) <= max;
}

function locked(entry: SearchEntry, ctx: SearchContext): boolean {
  const e = ctx.entitlements;
  switch (entry.needs) {
    case "bank_links":
      return !e.bank_links_max;
    case "backup":
      return !e.backup;
    case "household":
      return !e.household;
    case "groups_create":
      return !e.groups_create;
    default:
      return false;
  }
}

/** The entries this person can reach, each with where it goes (the plans when it's locked). */
export function reachable(ctx: SearchContext): SearchResult[] {
  const routes = accessRoutes(ctx.entitlements.access);
  const opens = (path: string) => !routes || mayOpen(routes, path.split("?")[0] ?? path);
  const out: SearchResult[] = [];
  for (const entry of SEARCH_ENTRIES) {
    if (entry.browserOnly && ctx.installed) continue;
    const isLocked = locked(entry, ctx);
    const path = isLocked ? PLAN_PATH : entry.path;
    // Never a result that leads somewhere this person can't open.
    if (!opens(path)) continue;
    out.push({ entry, locked: isLocked, path });
  }
  return out;
}

/**
 * Every word typed must start a word of the result (its label, where it lives or its everyday
 * words), or be within a typo or two of one. Labels that start with what was typed come first,
 * then labels that contain it, then everyday-word matches, then typo matches.
 */
export function search(
  query: string,
  ctx: SearchContext,
  options: { wide?: boolean; only?: SearchEntry["kind"][] } = {},
): SearchResult[] {
  const q = norm(query);
  if (!q) return [];
  const terms = q.split(" ");
  const joined = q.replace(/ /g, "");
  const wide = options.wide ?? false;
  const scored: [number, number, SearchResult][] = [];
  reachable(ctx).forEach((r, i) => {
    if (options.only && !options.only.includes(r.entry.kind)) return;
    const label = norm(r.entry.label);
    const words = `${label} ${norm(r.entry.section)} ${norm(r.entry.words)}`.split(" ");
    const exact = terms.every((t) => words.some((w) => w.startsWith(t)));
    // "darkmode" for "dark mode": two words typed as one.
    const pairs = words.map((w, k) => `${w}${words[k + 1] ?? ""}`);
    const squashed = joined.length > 3 && pairs.some((p) => p.startsWith(joined));
    const squashedLabel = joined.length > 3 && label.replace(/ /g, "").startsWith(joined);
    let score: number;
    if (label.startsWith(q) || squashedLabel) score = 0;
    else if (label.includes(q)) score = 1;
    else if (exact || squashed) score = 2;
    else if (
      terms.every((t) => words.some((w) => w.startsWith(t) || nearWord(t, w, wide))) ||
      (terms.length === 1 && pairs.some((p) => nearWord(joined, p, wide)))
    )
      score = 3;
    else return;
    scored.push([score, i, r]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , r]) => r);
}

/** When nothing matches: the closest few, allowing one more typo. */
export function closest(query: string, ctx: SearchContext): SearchResult[] {
  return search(query, ctx, { wide: true }).slice(0, 3);
}
