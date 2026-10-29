import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, api, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed, type StackdDb } from "../../data/db.ts";
import { todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { isOnline, onNetworkChange } from "../../pwa/network.ts";
import { useSession } from "../auth/useSession.tsx";
import {
  ensureHouseholdKey,
  fetchHouseholdStatus,
  HOUSEHOLD_ID,
  HOUSEHOLD_KEY,
  type HouseholdStatus,
  inviteLink,
  PARTNER_SUMMARY,
  publishHousehold,
  rememberHousehold,
  SHARE_SUMMARY,
  type SummaryBlob,
  splitLocally,
  syncHousehold,
} from "./householdSync.ts";

export const HOUSEHOLD_SYNC_INTERVAL_MS = 2 * 60 * 1000;

export function useHouseholdStatus(): {
  status: HouseholdStatus | null;
  error: ApiFailure | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<HouseholdStatus | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const refresh = useCallback(async () => {
    const r = await api.GET("/api/household");
    const failure = failureOf(r);
    if (failure) setError(failure);
    else {
      setError(null);
      setStatus(r.data as HouseholdStatus);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, error, refresh };
}

/** What this device knows locally: in a household (with the key), sharing totals, partner's totals. */
export function useHouseholdLocal():
  | {
      householdId: string | null;
      hasKey: boolean;
      shareSummary: boolean;
      partnerSummary: SummaryBlob | null;
    }
  | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [id, key, share, partner] = await Promise.all([
      db.settings.get(HOUSEHOLD_ID),
      db.settings.get(HOUSEHOLD_KEY),
      db.settings.get(SHARE_SUMMARY),
      db.settings.get(PARTNER_SUMMARY),
    ]);
    return {
      householdId: (id?.value as string | undefined) ?? null,
      hasKey: !!key,
      shareSummary: !!share?.value,
      partnerSummary: (partner?.value as SummaryBlob | undefined) ?? null,
    };
  }, [db]);
}

/** Start (or continue) the household and get a fresh invite link carrying the key. */
export async function createInvite(
  db: Parameters<typeof ensureHouseholdKey>[0],
): Promise<{ link: string; code: string } | ApiFailure> {
  const r = await api.POST("/api/household/invites");
  const failure = failureOf(r);
  if (failure || !r.data) return failure ?? { status: 500, code: "error" };
  const status = await fetchHouseholdStatus();
  if (status?.household) await rememberHousehold(db, status.household.id);
  const key = await ensureHouseholdKey(db);
  return { link: inviteLink(r.data.code, key), code: r.data.code };
}

export async function joinHousehold(
  db: Parameters<typeof rememberHousehold>[0],
  code: string,
  keyB64: string,
): Promise<HouseholdStatus["household"] | ApiFailure> {
  const r = await api.POST("/api/household/join", { body: { code } });
  const failure = failureOf(r);
  if (failure || !r.data) return failure ?? { status: 500, code: "error" };
  await rememberHousehold(db, r.data.id, keyB64);
  return r.data as HouseholdStatus["household"];
}

export async function leaveHousehold(
  db: Parameters<typeof splitLocally>[0],
  userId: string,
): Promise<ApiFailure | null> {
  const r = await api.POST("/api/household/leave");
  const failure = failureOf(r);
  if (failure && failure.status !== 404) return failure;
  await splitLocally(db, userId);
  return null;
}

export async function setShareSummary(
  db: Parameters<typeof splitLocally>[0],
  userId: string,
  on: boolean,
): Promise<void> {
  await db.settings.put({ key: SHARE_SUMMARY, value: on, updated_at: new Date().toISOString() });
  if (on) await publishHousehold(db, userId, todayIso());
}

export function isFailure(value: unknown): value is ApiFailure {
  return !!value && typeof value === "object" && "status" in value && "code" in value;
}

/**
 * Shared jars travel soon enough to feel shared (invariant 55, October 29, 2026). Before, a
 * deposit into a shared jar reached the partner only on the next 2-minute round, so two people
 * looking at the same jar saw different amounts. Now:
 * - a change to a shared jar or to my own events on one is published 2 s after the last change
 *   (`HOUSEHOLD_PUBLISH_DEBOUNCE_MS`; every write path, since it watches the tables),
 * - the app pulls when it comes back to the foreground,
 * - while the household screen or a shared jar is open, it pulls every 15 s
 *   (`HOUSEHOLD_CLOSE_SYNC_MS`; owner sign-off, October 29, 2026), and the 2-minute round goes on.
 * Publishing sends nothing when the blob is unchanged (its hash), so calling it often is cheap.
 */
export const HOUSEHOLD_PUBLISH_DEBOUNCE_MS = 2000;
export const HOUSEHOLD_CLOSE_SYNC_MS = 15 * 1000;

let closeWatchers = 0;

/** A screen showing shared jars (the household screen, a shared jar) asks for quicker pulls. */
export function useHouseholdCloseSync(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    closeWatchers += 1;
    return () => {
      closeWatchers -= 1;
    };
  }, [active]);
}

/** What this person shares, as one string: changes when a shared jar or my event on one does. */
async function sharedFingerprint(db: StackdDb, userId: string): Promise<string> {
  const id = (await db.settings.get(HOUSEHOLD_ID))?.value as string | undefined;
  if (!id) return "";
  const goals = await db.goals.where("household_id").equals(id).toArray();
  const ids = new Set(goals.map((g) => g.id));
  const events = (await db.goal_events.toArray()).filter(
    (e) => ids.has(e.goal_id) && (e.member_id ?? userId) === userId,
  );
  return [
    ...goals.map((g) => `${g.id}:${g.updated_at}:${g.status}`).sort(compareText),
    ...events.map((e) => `${e.id}:${e.amount_cents ?? ""}:${e.date}`).sort(compareText),
  ].join("|");
}

/**
 * Mounted once in the shell: pull and publish on open, on reconnect, on coming back to the
 * foreground, every two minutes (every 15 s while shared jars are on screen), and publish
 * 2 s after a shared jar changes.
 */
export function useHouseholdSync(): void {
  const { db } = useDb();
  const { info } = useSession();
  const userId = info?.user?.id ?? null;
  const running = useRef(false);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let lastRun = 0;
    const run = () => {
      if (!alive || running.current || !isOnline()) return;
      running.current = true;
      lastRun = Date.now();
      void (async () => {
        if (!(await db.settings.get(HOUSEHOLD_ID))) return;
        await syncHousehold(db, userId, todayIso());
      })()
        .catch(ignoreClosed)
        .catch(() => null)
        .finally(() => {
          running.current = false;
        });
    };
    const tick = () => {
      if (closeWatchers > 0 || Date.now() - lastRun >= HOUSEHOLD_SYNC_INTERVAL_MS) run();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    run();
    const timer = setInterval(tick, HOUSEHOLD_CLOSE_SYNC_MS);
    const off = onNetworkChange(run);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [db, userId]);

  const fingerprint = useLiveQuery(
    async () => (userId ? sharedFingerprint(db, userId).catch(() => "") : ""),
    [db, userId],
  );
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (fingerprint === undefined || !userId) return;
    const before = seen.current;
    seen.current = fingerprint;
    // The first reading is what was there on open (the round above sends it); later ones are edits.
    if (before === undefined || before === fingerprint || fingerprint === "") return;
    const timer = setTimeout(() => {
      if (!isOnline()) return; // the round on reconnect sends it
      void publishHousehold(db, userId, todayIso(), true)
        .catch(ignoreClosed)
        .catch(() => null);
    }, HOUSEHOLD_PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [db, userId, fingerprint]);
}

export function HouseholdSync() {
  useHouseholdSync();
  return null;
}
