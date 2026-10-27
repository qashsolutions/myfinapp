import "./pwa.css";

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { flushServerQueue } from "../../data/serverQueue.ts";
import { isOnline, onNetworkChange } from "../../pwa/network.ts";

/**
 * "You're offline" (mockup PwaStates): entries and jars keep working on the device; whatever
 * is waiting for the server (group percentages) goes when the connection is back, oldest first.
 */
export function OfflineBanner() {
  const { db } = useDb();
  const [online, setOnline] = useState(isOnline());
  const pending = useLiveQuery(() => db.server_queue.count(), [db]) ?? 0;
  useEffect(
    () =>
      onNetworkChange(() => {
        const now = isOnline();
        setOnline(now);
        if (now) void flushServerQueue(db);
      }),
    [db],
  );
  if (online && pending === 0) return null;
  return (
    <div className="offline-banner" role="status">
      <span aria-hidden="true">{online ? "⏳" : "⚠"}</span>
      <div>
        <p className="offline-banner__title">{online ? "Syncing" : "You're offline"}</p>
        <p className="offline-banner__sub">
          {online
            ? `${pending} ${pending === 1 ? "change" : "changes"} waiting to sync.`
            : `Changes are saved on this device and sync when you're back.${pending ? ` ${pending} waiting.` : ""}`}
        </p>
      </div>
    </div>
  );
}
