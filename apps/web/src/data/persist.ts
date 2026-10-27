/**
 * Device storage can be lost (docs/spec.md "Architecture & stack"): browsers may clear site
 * data, and Safari erases script-written storage for sites unused for seven days. Mitigations
 * here: ask for persistent storage, report how much is used, and nudge Free users to export.
 * (The install prompt is chunk 1.12; the export itself is 1.11; the encrypted backup is 1.16.)
 */

export type PersistenceState = "persisted" | "denied" | "unsupported";

export async function requestPersistence(): Promise<PersistenceState> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist) return "unsupported";
  try {
    if (await storage.persisted?.()) return "persisted";
    return (await storage.persist()) ? "persisted" : "denied";
  } catch {
    return "unsupported";
  }
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

export async function storageEstimate(): Promise<StorageEstimate | null> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Proposed: remind Free users to export once they have 20+ entries and no export in 30 days. */
export const EXPORT_NUDGE_MIN_ENTRIES = 20;
export const EXPORT_NUDGE_AFTER_DAYS = 30;

export function shouldNudgeExport(
  entryCount: number,
  lastExportAt: string | null,
  now: Date = new Date(),
): boolean {
  if (entryCount < EXPORT_NUDGE_MIN_ENTRIES) return false;
  if (!lastExportAt) return true;
  const ageDays = (now.getTime() - new Date(lastExportAt).getTime()) / 86_400_000;
  return ageDays >= EXPORT_NUDGE_AFTER_DAYS;
}
