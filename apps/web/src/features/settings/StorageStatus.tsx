import { Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { formatBytes, type StorageEstimate, storageEstimate } from "../../data/persist.ts";

/** Settings → Receipts & your data: where the data is and whether the browser may keep it. */
export function StorageStatus() {
  const { db, persistence } = useDb();
  const count = useLiveQuery(() => db.entries.count(), [db]);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  useEffect(() => {
    void storageEstimate().then(setEstimate);
  }, []);
  const persistenceLine =
    persistence === "persisted"
      ? "This browser has agreed to keep it."
      : persistence === "denied"
        ? "This browser may clear it if space runs low; adding Qash to your Home Screen helps."
        : persistence === "unsupported"
          ? "This browser can't promise to keep it."
          : "Checking whether this browser will keep it…";
  return (
    <section aria-labelledby="data-h">
      <h2 className="section-title" id="data-h">
        Receipts & your data
      </h2>
      <Card>
        <p>
          <strong>{count ?? 0}</strong> {count === 1 ? "entry" : "entries"}, stored only on this
          device
          {estimate ? ` (${formatBytes(estimate.usage)} used)` : ""}.
        </p>
        <p className="sk-card__eyebrow">{persistenceLine}</p>
      </Card>
    </section>
  );
}
