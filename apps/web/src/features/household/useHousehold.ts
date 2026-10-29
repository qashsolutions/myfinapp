import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, api, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import { todayIso } from "../../lib/format.ts";
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

/** Mounted once in the shell: pull and publish on open, on reconnect, and every two minutes. */
export function useHouseholdSync(): void {
  const { db } = useDb();
  const { info } = useSession();
  const userId = info?.user?.id ?? null;
  const running = useRef(false);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    const run = () => {
      if (!alive || running.current || !isOnline()) return;
      running.current = true;
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
    run();
    const timer = setInterval(run, HOUSEHOLD_SYNC_INTERVAL_MS);
    const off = onNetworkChange(run);
    return () => {
      alive = false;
      clearInterval(timer);
      off();
    };
  }, [db, userId]);
}

export function HouseholdSync() {
  useHouseholdSync();
  return null;
}
