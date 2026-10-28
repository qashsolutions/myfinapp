/**
 * Couples & household on the device (docs/spec.md "Couples & household"). The household key is
 * made on the inviter's device and travels only in the invite link's fragment; shared jars and
 * the optional month totals go to the server as ciphertext under that key, one blob per author
 * and kind. Pulling merges the partner's shared jars and their deposits; leaving keeps each
 * person's own deposits (the `household.split_contributions` rule says what is whose).
 */

import { api, clientFor, failureOf } from "../../data/api.ts";
import {
  decryptJson,
  encryptJson,
  fromBase64url,
  randomBytes,
  sha256Hex,
  toBase64url,
} from "../../data/backup/crypto.ts";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import {
  counted,
  entriesBetween,
  type Goal,
  type GoalEvent,
  type StackdDb,
} from "../../data/db.ts";
import { monthBounds, monthTotals } from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { toRuleEntry } from "../money/ruleEntries.ts";

export const HOUSEHOLD_KEY = "household.key";
export const HOUSEHOLD_ID = "household.id";
export const SHARE_SUMMARY = "household.share_summary";
const JARS_HASH = "household.jars_hash";
const JARS_VERSION = "household.jars_version";
const SUMMARY_HASH = "household.summary_hash";
const SUMMARY_VERSION = "household.summary_version";
export const PARTNER_SUMMARY = "household.partner_summary";
export const LAST_PULL = "household.last_pull_at";

export interface HouseholdMember {
  user_id: string;
  display_name: string;
  initial: string;
  is_me: boolean;
  joined_at: string;
}

export interface HouseholdInfo {
  id: string;
  owner_id: string;
  created_at: string;
  members: HouseholdMember[];
  invite: { code: string; expires_at: string } | null;
}

export interface HouseholdStatus {
  household: HouseholdInfo | null;
  available: boolean;
}

export interface JarsBlob {
  version: 1;
  goals: Goal[];
  events: GoalEvent[];
}

export interface SummaryBlob {
  version: 1;
  member_id: string;
  month: string; // YYYY-MM-DD, the month's first day
  in_cents: number;
  out_cents: number;
  updated_at: string;
}

async function setting<T>(db: StackdDb, key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

async function putSetting(db: StackdDb, key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value, updated_at: new Date().toISOString() });
}

export async function householdKey(db: StackdDb): Promise<Uint8Array | null> {
  const text = await setting<string>(db, HOUSEHOLD_KEY);
  return text ? fromBase64url(text) : null;
}

export async function householdId(db: StackdDb): Promise<string | null> {
  return (await setting<string>(db, HOUSEHOLD_ID)) ?? null;
}

/** The inviter makes the key once; the same key goes into every invite link. */
export async function ensureHouseholdKey(db: StackdDb): Promise<string> {
  const existing = await setting<string>(db, HOUSEHOLD_KEY);
  if (existing) return existing;
  const key = toBase64url(randomBytes(32));
  await putSetting(db, HOUSEHOLD_KEY, key);
  return key;
}

export async function rememberHousehold(db: StackdDb, id: string, keyB64?: string): Promise<void> {
  await putSetting(db, HOUSEHOLD_ID, id);
  if (keyB64) await putSetting(db, HOUSEHOLD_KEY, keyB64);
}

export function inviteLink(code: string, keyB64: string): string {
  return `${globalThis.location?.origin ?? ""}/household/join?code=${code}#k=${keyB64}`;
}

const aad = (householdId: string) => `stackd-household:${householdId}`;

export async function fetchHouseholdStatus(background = false): Promise<HouseholdStatus | null> {
  const r = await clientFor(background).GET("/api/household");
  if (failureOf(r) || !r.data) return null;
  return r.data as HouseholdStatus;
}

async function sharedGoals(db: StackdDb, id: string): Promise<Goal[]> {
  return db.goals.where("household_id").equals(id).toArray();
}

/** This device's month totals for the summary (totals only; the rule never sees an entry). */
export async function myMonthSummary(
  db: StackdDb,
  userId: string,
  asOf: string,
): Promise<SummaryBlob> {
  const bounds = await monthBounds(asOf);
  const categories = new Map((await db.categories.toArray()).map((c) => [c.id, c]));
  const entries = await entriesBetween(db, bounds.start, bounds.end);
  const totals = await monthTotals(
    bounds.start,
    counted(entries).map((e) => toRuleEntry(e, categories)),
  );
  return {
    version: 1,
    member_id: userId,
    month: totals.start,
    in_cents: totals.in_cents,
    out_cents: totals.out_cents,
    updated_at: new Date().toISOString(),
  };
}

async function putBlob(
  kind: "jars" | "summary",
  ciphertext: Uint8Array,
  version: number,
  background: boolean,
): Promise<boolean> {
  const r = await clientFor(background).PUT("/api/household/blobs/{kind}", {
    params: { path: { kind } },
    body: { ciphertext: toBase64url(ciphertext), version },
  });
  return !failureOf(r);
}

/** Send what is mine: shared jars with my deposits, and my month totals when I chose to share. */
export async function publishHousehold(
  db: StackdDb,
  userId: string,
  asOf: string,
  background = false,
): Promise<{ jars: boolean; summary: boolean }> {
  const id = await householdId(db);
  const key = await householdKey(db);
  if (!id || !key) return { jars: false, summary: false };
  const goals = await sharedGoals(db, id);
  const goalIds = new Set(goals.map((g) => g.id));
  const events = (await db.goal_events.toArray()).filter(
    (e) => goalIds.has(e.goal_id) && (e.member_id ?? userId) === userId,
  );
  const jars: JarsBlob = {
    version: 1,
    goals: goals.sort((a, b) => compareText(a.id, b.id)),
    events: events.sort((a, b) => compareText(a.id, b.id)),
  };
  let jarsSent = false;
  const jarsHash = await sha256Hex(JSON.stringify(jars));
  if ((await setting<string>(db, JARS_HASH)) !== jarsHash) {
    const version = ((await setting<number>(db, JARS_VERSION)) ?? 0) + 1;
    if (await putBlob("jars", await encryptJson(key, jars, aad(id)), version, background)) {
      await putSetting(db, JARS_HASH, jarsHash);
      await putSetting(db, JARS_VERSION, version);
      jarsSent = true;
    }
  }
  let summarySent = false;
  if (await setting<boolean>(db, SHARE_SUMMARY)) {
    const summary = await myMonthSummary(db, userId, asOf);
    const summaryHash = await sha256Hex(JSON.stringify({ ...summary, updated_at: null }));
    if ((await setting<string>(db, SUMMARY_HASH)) !== summaryHash) {
      const version = ((await setting<number>(db, SUMMARY_VERSION)) ?? 0) + 1;
      if (await putBlob("summary", await encryptJson(key, summary, aad(id)), version, background)) {
        await putSetting(db, SUMMARY_HASH, summaryHash);
        await putSetting(db, SUMMARY_VERSION, version);
        summarySent = true;
      }
    }
  }
  return { jars: jarsSent, summary: summarySent };
}

export interface PullReport {
  goalsAdded: number;
  eventsAdded: number;
  partnerSummary: SummaryBlob | null;
}

/** Bring in the partner's shared jars and deposits, and their month totals if they share them. */
export async function pullHousehold(
  db: StackdDb,
  userId: string,
  background = false,
): Promise<PullReport> {
  const report: PullReport = { goalsAdded: 0, eventsAdded: 0, partnerSummary: null };
  const id = await householdId(db);
  const key = await householdKey(db);
  if (!id || !key) return report;
  const r = await clientFor(background).GET("/api/household/blobs");
  if (failureOf(r) || !r.data) return report;
  for (const blob of r.data) {
    if (blob.author_id === userId) continue;
    let plain: unknown;
    try {
      plain = await decryptJson<unknown>(key, fromBase64url(blob.ciphertext), aad(id));
    } catch {
      continue; // a blob under another key (a household this device never joined)
    }
    if (blob.kind === "jars" && isJars(plain)) {
      await db.transaction("rw", db.goals, db.goal_events, async () => {
        for (const g of plain.goals) {
          const mine = await db.goals.get(g.id);
          if (!mine) {
            await db.goals.add({ ...g, household_id: id });
            report.goalsAdded += 1;
          } else if (mine.household_id === id && g.updated_at > mine.updated_at) {
            await db.goals.put({ ...g, household_id: id });
          }
        }
        for (const e of plain.events) {
          if (e.member_id === userId) continue;
          if (!(await db.goal_events.get(e.id))) {
            try {
              await db.goal_events.add({ ...e, member_id: e.member_id ?? blob.author_id });
              report.eventsAdded += 1;
            } catch {
              // already here
            }
          }
        }
      });
    } else if (blob.kind === "summary" && isSummary(plain)) {
      report.partnerSummary = plain;
      await putSetting(db, PARTNER_SUMMARY, plain);
    }
  }
  await putSetting(db, LAST_PULL, new Date().toISOString());
  return report;
}

function isJars(v: unknown): v is JarsBlob {
  return (
    !!v &&
    typeof v === "object" &&
    (v as JarsBlob).version === 1 &&
    Array.isArray((v as JarsBlob).goals) &&
    Array.isArray((v as JarsBlob).events)
  );
}

function isSummary(v: unknown): v is SummaryBlob {
  const s = v as SummaryBlob;
  return (
    !!v &&
    typeof v === "object" &&
    s.version === 1 &&
    typeof s.member_id === "string" &&
    Number.isInteger(s.in_cents) &&
    Number.isInteger(s.out_cents)
  );
}

/**
 * The split: every shared jar stays, holding only this person's deposits; the partner's
 * deposits go (they keep them on their side). The household key and settings are forgotten.
 */
export async function splitLocally(db: StackdDb, userId: string): Promise<number> {
  const id = await householdId(db);
  let kept = 0;
  if (id) {
    await db.transaction("rw", db.goals, db.goal_events, db.tombstones, async () => {
      for (const goal of await sharedGoals(db, id)) {
        const events = await db.goal_events.where("goal_id").equals(goal.id).toArray();
        const theirs = events.filter((e) => (e.member_id ?? userId) !== userId).map((e) => e.id);
        if (theirs.length) {
          await db.goal_events.bulkDelete(theirs);
          await recordDeletion(db, "goal_events", theirs);
        }
        await db.goals.update(goal.id, {
          household_id: null,
          updated_at: new Date().toISOString(),
        });
        kept += 1;
      }
    });
  }
  for (const k of [
    HOUSEHOLD_KEY,
    HOUSEHOLD_ID,
    SHARE_SUMMARY,
    JARS_HASH,
    JARS_VERSION,
    SUMMARY_HASH,
    SUMMARY_VERSION,
    PARTNER_SUMMARY,
    LAST_PULL,
  ])
    await db.settings.delete(k);
  return kept;
}

/** The partner left: their deposits leave this copy too; the jars stay shared-ready for a new partner. */
export async function dropPartnerEvents(db: StackdDb, userId: string): Promise<void> {
  const id = await householdId(db);
  if (!id) return;
  await db.transaction("rw", db.goals, db.goal_events, db.tombstones, async () => {
    for (const goal of await sharedGoals(db, id)) {
      const events = await db.goal_events.where("goal_id").equals(goal.id).toArray();
      const theirs = events.filter((e) => (e.member_id ?? userId) !== userId).map((e) => e.id);
      if (theirs.length) {
        await db.goal_events.bulkDelete(theirs);
        await recordDeletion(db, "goal_events", theirs);
      }
    }
  });
  await db.settings.delete(PARTNER_SUMMARY);
}

/** One round: what the server says, then pull and publish. Safe to call often. */
export async function syncHousehold(
  db: StackdDb,
  userId: string,
  asOf: string,
): Promise<HouseholdStatus | null> {
  const status = await fetchHouseholdStatus(true);
  if (!status) return null;
  const localId = await householdId(db);
  if (!status.household) {
    if (localId) await splitLocally(db, userId);
    return status;
  }
  if (localId !== status.household.id) return status; // joined elsewhere; this device has no key
  if (status.household.members.length < 2) await dropPartnerEvents(db, userId);
  await pullHousehold(db, userId, true);
  await publishHousehold(db, userId, asOf, true);
  return status;
}
