import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { Receipt, ReceiptRetention, StoredFile } from "../../data/db.ts";
import { DEFAULT_RETENTION, getRetention, RETENTION_KEY } from "../../data/receipts.ts";

export function useRetention(): ReceiptRetention {
  const { db } = useDb();
  return (
    useLiveQuery(async () => {
      await db.settings.get(RETENTION_KEY); // subscribe to the setting
      return getRetention(db);
    }, [db]) ?? DEFAULT_RETENTION
  );
}

export function useReceipt(
  id: string | null,
): { receipt: Receipt | null; file: StoredFile | null } | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    if (!id) return { receipt: null, file: null };
    const receipt = (await db.receipts.get(id)) ?? null;
    const file = receipt?.file_id ? ((await db.files.get(receipt.file_id)) ?? null) : null;
    return { receipt, file };
  }, [db, id]);
}

/** An object URL for a stored blob, revoked on change; null where the browser has none (tests). */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || !(blob instanceof Blob) || typeof URL.createObjectURL !== "function") {
      setUrl(null);
      return;
    }
    let next: string;
    try {
      next = URL.createObjectURL(blob);
    } catch {
      setUrl(null);
      return;
    }
    setUrl(next);
    return () => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(next);
    };
  }, [blob]);
  return url;
}
