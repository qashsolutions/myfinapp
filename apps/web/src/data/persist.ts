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

/*
 * The "keep it safe" card (defect round 3, October 29, 2026; invariant 58). Safari on iPhone
 * erases a site's data after 7 days without a visit, unless it is on the Home Screen, and backup
 * is a choice, so a browser-tab user is told from day 1 and offered a way out until one is done:
 * installed, backup on, or a copy downloaded in the last EXPORT_NUDGE_AFTER_DAYS. Elsewhere the
 * export reminder above applies wherever the browser hasn't promised to keep the data.
 * "Not now" hides it for STORAGE_CARD_SNOOZE_DAYS, but it is always shown again after a gap of
 * STORAGE_CARD_GAP_DAYS since the last open, when the 7 days are close.
 */
export const STORAGE_CARD_SNOOZE_DAYS = 3; // proposed, awaiting owner sign-off
export const STORAGE_CARD_GAP_DAYS = 5; // proposed, awaiting owner sign-off

export type StorageRisk = "iphone_tab" | "export" | null;

export interface StorageRiskInput {
  /** An iPhone or iPad browser tab: not the Home Screen app, not a native shell. */
  iphoneTab: boolean;
  persistence: PersistenceState | "pending";
  backupOn: boolean;
  entryCount: number;
  lastExportAt: string | null;
  snoozedAt: string | null;
  /** The open before this one. */
  lastOpenAt: string | null;
  now: Date;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : (now.getTime() - t) / 86_400_000;
}

export function storageRisk(input: StorageRiskInput): StorageRisk {
  if (input.backupOn) return null;
  const exported = daysSince(input.lastExportAt, input.now);
  const gap = daysSince(input.lastOpenAt, input.now);
  const snoozed = daysSince(input.snoozedAt, input.now);
  const quiet =
    snoozed !== null &&
    snoozed < STORAGE_CARD_SNOOZE_DAYS &&
    !(gap !== null && gap >= STORAGE_CARD_GAP_DAYS);
  if (input.iphoneTab) {
    if (exported !== null && exported < EXPORT_NUDGE_AFTER_DAYS) return null;
    return quiet ? null : "iphone_tab";
  }
  if (input.persistence !== "denied" && input.persistence !== "unsupported") return null;
  if (!shouldNudgeExport(input.entryCount, input.lastExportAt, input.now)) return null;
  return quiet ? null : "export";
}

const LAST_EXPORT = "stackd.last_export.";
const SNOOZED = "stackd.storage_card_snoozed";
const LAST_OPEN = "stackd.last_open";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the card just shows again next time
  }
}

/** A copy of everything was downloaded on this device (the export, built here). */
export function recordExport(userId: string, now: Date = new Date()): void {
  write(LAST_EXPORT + userId, now.toISOString());
}

export function lastExportAt(userId: string): string | null {
  return read(LAST_EXPORT + userId);
}

export function snoozeStorageCard(now: Date = new Date()): void {
  write(SNOOZED, now.toISOString());
}

export function storageCardSnoozedAt(): string | null {
  return read(SNOOZED);
}

let lastOpen: { before: string | null } | null = null;

/** The open before this one; this open is recorded the first time it is asked in a page load. */
export function lastOpenBefore(now: Date = new Date()): string | null {
  if (!lastOpen) {
    lastOpen = { before: read(LAST_OPEN) };
    write(LAST_OPEN, now.toISOString());
  }
  return lastOpen.before;
}

/** Tests: start a fresh page load. */
export function resetLastOpen(): void {
  lastOpen = null;
}
