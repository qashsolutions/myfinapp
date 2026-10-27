/**
 * Opens the signed-in user's database, seeds defaults, and asks for persistent storage.
 * Mounted inside RequireAuth, so every screen below can `useDb()`.
 */

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "../features/auth/useSession.tsx";
import { todayIso } from "../lib/format.ts";
import { ignoreClosed, openDb, type StackdDb, seedDefaults } from "./db.ts";
import { type PersistenceState, requestPersistence } from "./persist.ts";
import { purgeExpiredReceipts } from "./receipts.ts";

export interface DeviceData {
  db: StackdDb;
  persistence: PersistenceState | "pending";
}

const DbContext = createContext<DeviceData | null>(null);

export function DbProvider({ children }: { children: ReactNode }) {
  const { info } = useSession();
  const userId = info?.user?.id ?? null;
  const [persistence, setPersistence] = useState<PersistenceState | "pending">("pending");
  const [seeded, setSeeded] = useState<string | null>(null);
  const db = useMemo(() => (userId ? openDb(userId) : null), [userId]);

  useEffect(() => {
    if (!db || !userId) return;
    let alive = true;
    void seedDefaults(db)
      .then(async () => {
        if (alive) setSeeded(userId);
        // Receipt photos past their retention date go now, before any screen shows them.
        await purgeExpiredReceipts(db, todayIso()).catch(() => {});
      })
      .catch(ignoreClosed);
    void requestPersistence().then((state) => {
      if (alive) setPersistence(state);
    });
    return () => {
      alive = false;
    };
  }, [db, userId]);

  const value = useMemo<DeviceData | null>(
    () => (db && seeded === userId ? { db, persistence } : null),
    [db, seeded, userId, persistence],
  );
  if (!value) {
    return (
      <p className="sr-only" role="status">
        Opening your data
      </p>
    );
  }
  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
}

export function useDb(): DeviceData {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error("useDb must be used inside <DbProvider>");
  return ctx;
}
