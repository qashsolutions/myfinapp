/**
 * The person's own subscription kinds and words (owner decision, October 29, 2026; docs/spec.md
 * "Subscriptions"). Qash's own list is fixed; these sit beside it, on this device and in the
 * encrypted backup only. The words are cleaned exactly like the table's (upper-case ASCII, single
 * spaces) and matched by `recurring.subscription_check` as whole words, before the table.
 * No money math here, so nothing goes through the engine.
 */

import { useLiveQuery } from "dexie-react-hooks";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import type { OwnSubscriptionKind, OwnSubscriptionWord, StackdDb } from "../../data/db.ts";
import { byLabel, compareText } from "../../lib/order.ts";
import { KIND_NAMES, OTHER_KIND } from "./kinds.ts";

/** A kind's name: 1 to 24 characters (as categories). */
export const KIND_NAME_MAX = 24;
/** At most this many own kinds (proposed, awaiting owner sign-off). */
export const MAX_OWN_KINDS = 20;
/** A word: 2 to 40 characters. */
export const WORD_MIN = 2;
export const WORD_MAX = 40;
/** At most this many own words (proposed, awaiting owner sign-off). */
export const MAX_OWN_WORDS = 100;
/** Own kind ids start here, so one never meets a kind of the table or Other. */
export const OWN_PREFIX = "own-";

/** Letters, digits, spaces and the punctuation the table's words use (' * + .). */
const WORD_CHARS = /^[A-Z0-9 '*+.]+$/;
const HAS_LETTER_OR_DIGIT = /[A-Z0-9]/;

function tidy(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export type KindNameCheck = { name: string } | { problem: string };

/** Trimmed, 1–24 characters, unique ignoring case against Qash's names, Other and their own. */
export function checkKindName(
  raw: string,
  own: OwnSubscriptionKind[],
  self?: string,
): KindNameCheck {
  const name = tidy(raw);
  if (!name) return { problem: "Give the kind a name." };
  if ([...name].length > KIND_NAME_MAX)
    return { problem: `Keep it to ${KIND_NAME_MAX} characters.` };
  const lower = name.toLowerCase();
  if (KIND_NAMES.some((k) => k.label.toLowerCase() === lower) || lower === "other")
    return { problem: "Qash already has a kind with that name. Pick it from the list." };
  if (own.some((k) => k.id !== self && k.label.toLowerCase() === lower))
    return { problem: "You already have a kind with that name." };
  return { name };
}

export type WordCheck = { match: string } | { problem: string };

/** A word as it is kept: trimmed, single spaces, upper-case (the table's words are). */
export function normalizeWord(raw: string): string {
  return tidy(raw).toUpperCase();
}

/** Upper-case like the table, 2–40 characters of A–Z, 0–9, spaces and ' * + . , once only. */
export function checkWord(raw: string, own: OwnSubscriptionWord[], self?: string): WordCheck {
  const match = normalizeWord(raw);
  if (!match) return { problem: "Type a word from the charge, like NETFLIX." };
  if (!WORD_CHARS.test(match)) return { problem: "Use letters, numbers, spaces and ' * + . only." };
  if (!HAS_LETTER_OR_DIGIT.test(match)) return { problem: "Put a letter or number in it." };
  if (match.length < WORD_MIN || match.length > WORD_MAX)
    return { problem: `Keep it to ${WORD_MIN} to ${WORD_MAX} characters.` };
  if (own.some((w) => w.id !== self && w.match === match))
    return { problem: "You already have that word." };
  return { match };
}

/** Bank prefixes that say how it was paid, not who: never offered as the word. */
const PREFIXES = new Set(["SQ", "TST", "SP", "POS", "ACH", "DEBIT", "PURCHASE", "PAYPAL", "PP"]);

/**
 * A sensible word from the cleaned payee, for "Also for future charges like this" (editable):
 * the first part of at least three letters that is not a payment prefix and has no digits, with
 * a web ending (.COM, .NET, .ORG) dropped; else the payee itself cut to 40.
 */
export function suggestWord(payee: string): string {
  const clean = tidy(payee).toUpperCase();
  for (const raw of clean.split(/[ *]+/)) {
    const part = raw.replace(/\.(COM|NET|ORG|CO|IO|TV)$/, "").replace(/^[.'+]+|[.'+]+$/g, "");
    if (part.length < 3 || /[0-9]/.test(part) || PREFIXES.has(part)) continue;
    if (!WORD_CHARS.test(part)) continue;
    return part.slice(0, WORD_MAX);
  }
  return clean
    .replace(/[^A-Z0-9 '*+.]/g, "")
    .trim()
    .slice(0, WORD_MAX);
}

/** Their kinds, by name; their words, longest first so the more exact word wins, then A–Z. */
export function orderWords(words: OwnSubscriptionWord[]): OwnSubscriptionWord[] {
  return [...words].sort(
    (a, b) => b.match.length - a.match.length || compareText(a.match, b.match),
  );
}

export interface OwnKinds {
  kinds: OwnSubscriptionKind[];
  words: OwnSubscriptionWord[];
  /** Own kind id → its name, for the labels. */
  labels: ReadonlyMap<string, string>;
}

export function ownKindsOf(kinds: OwnSubscriptionKind[], words: OwnSubscriptionWord[]): OwnKinds {
  const sorted = [...kinds].sort((a, b) => byLabel(a.label, b.label) || compareText(a.id, b.id));
  return {
    kinds: sorted,
    words: orderWords(words),
    labels: new Map(sorted.map((k) => [k.id, k.label])),
  };
}

/** Live: the person's own kinds and words. */
export function useOwnKinds(): OwnKinds | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [kinds, words] = await Promise.all([
      db.own_subscription_kinds.toArray(),
      db.own_subscription_words.toArray(),
    ]);
    return ownKindsOf(kinds, words);
  }, [db]);
}

/** The kinds a word or a subscription may name: Qash's, then their own. */
export function kindChoices(own: OwnSubscriptionKind[]): Array<[string, string]> {
  return [
    ...KIND_NAMES.map((k): [string, string] => [k.kind, k.label]),
    ...own.map((k): [string, string] => [k.id, k.label]),
  ];
}

/** Whether a kind is one the rule knows now: Qash's, Other, or one of theirs. */
export function isKnownKind(kind: string, own: ReadonlyMap<string, string>): boolean {
  return kind === OTHER_KIND || own.has(kind) || KIND_NAMES.some((k) => k.kind === kind);
}

export class OwnKindError extends Error {}

function stamp(now: Date): string {
  return now.toISOString();
}

export async function createOwnKind(
  db: StackdDb,
  rawName: string,
  now: Date = new Date(),
): Promise<OwnSubscriptionKind> {
  return db.transaction("rw", db.own_subscription_kinds, async () => {
    const all = await db.own_subscription_kinds.toArray();
    const checked = checkKindName(rawName, all);
    if ("problem" in checked) throw new OwnKindError(checked.problem);
    if (all.length >= MAX_OWN_KINDS)
      throw new OwnKindError(`You have ${MAX_OWN_KINDS} kinds of your own. Remove one first.`);
    const row: OwnSubscriptionKind = {
      id: `${OWN_PREFIX}${crypto.randomUUID()}`,
      label: checked.name,
      created_at: stamp(now),
      updated_at: stamp(now),
    };
    await db.own_subscription_kinds.add(row);
    return row;
  });
}

export async function renameOwnKind(
  db: StackdDb,
  id: string,
  rawName: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction("rw", db.own_subscription_kinds, async () => {
    const all = await db.own_subscription_kinds.toArray();
    const checked = checkKindName(rawName, all, id);
    if ("problem" in checked) throw new OwnKindError(checked.problem);
    await db.own_subscription_kinds.update(id, { label: checked.name, updated_at: stamp(now) });
  });
}

/**
 * Removes an own kind: its subscriptions go back to the kind from their name, and the words
 * that named it go too (remembered as removed, so a sync never brings them back).
 */
export async function removeOwnKind(
  db: StackdDb,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(
    "rw",
    [db.own_subscription_kinds, db.own_subscription_words, db.recurring_series, db.tombstones],
    async () => {
      const series = await db.recurring_series.filter((s) => s.subscription_kind === id).toArray();
      for (const s of series)
        await db.recurring_series.update(s.id, { subscription_kind: null, updated_at: stamp(now) });
      const words = await db.own_subscription_words.where("kind").equals(id).primaryKeys();
      await db.own_subscription_words.bulkDelete(words);
      await recordDeletion(db, "own_subscription_words", words);
      await db.own_subscription_kinds.delete(id);
      await recordDeletion(db, "own_subscription_kinds", [id]);
    },
  );
}

export async function addOwnWord(
  db: StackdDb,
  raw: string,
  kind: string,
  now: Date = new Date(),
): Promise<OwnSubscriptionWord> {
  return db.transaction("rw", db.own_subscription_words, db.own_subscription_kinds, async () => {
    const [all, kinds] = await Promise.all([
      db.own_subscription_words.toArray(),
      db.own_subscription_kinds.toArray(),
    ]);
    const checked = checkWord(raw, all);
    if ("problem" in checked) throw new OwnKindError(checked.problem);
    if (kind === OTHER_KIND || !isKnownKind(kind, new Map(kinds.map((k) => [k.id, k.label]))))
      throw new OwnKindError("Pick the kind it means.");
    if (all.length >= MAX_OWN_WORDS)
      throw new OwnKindError(`You have ${MAX_OWN_WORDS} words of your own. Remove one first.`);
    const row: OwnSubscriptionWord = {
      id: crypto.randomUUID(),
      match: checked.match,
      kind,
      created_at: stamp(now),
      updated_at: stamp(now),
    };
    await db.own_subscription_words.add(row);
    return row;
  });
}

export async function updateOwnWord(
  db: StackdDb,
  id: string,
  raw: string,
  kind: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction("rw", db.own_subscription_words, db.own_subscription_kinds, async () => {
    const [all, kinds] = await Promise.all([
      db.own_subscription_words.toArray(),
      db.own_subscription_kinds.toArray(),
    ]);
    const checked = checkWord(raw, all, id);
    if ("problem" in checked) throw new OwnKindError(checked.problem);
    if (kind === OTHER_KIND || !isKnownKind(kind, new Map(kinds.map((k) => [k.id, k.label]))))
      throw new OwnKindError("Pick the kind it means.");
    await db.own_subscription_words.update(id, {
      match: checked.match,
      kind,
      updated_at: stamp(now),
    });
  });
}

export async function removeOwnWord(db: StackdDb, id: string): Promise<void> {
  await db.transaction("rw", db.own_subscription_words, db.tombstones, async () => {
    await db.own_subscription_words.delete(id);
    await recordDeletion(db, "own_subscription_words", [id]);
  });
}
