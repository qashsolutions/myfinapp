/**
 * Backup on, restore, and keeping two devices in step (docs/spec.md "End-to-end encrypted
 * backup", chunk 1.16). The backup key is made here and stays here; the server holds wrapped
 * copies (under the recovery key, and under the passkey's PRF output when the browser gives
 * one) plus ciphertext. A sync is: pull the newest backup, merge it, push when ours differs.
 */

import { api, failureOf } from "../api.ts";
import type { StackdDb } from "../db.ts";
import {
  CryptoError,
  decryptJson,
  deriveWrappingKey,
  encryptJson,
  formatRecoveryKey,
  fromBase64url,
  parseRecoveryKey,
  RECOVERY_BYTES,
  randomBytes,
  toBase64url,
  unwrapKey,
  WRAP_INFO,
  wrapKey,
} from "./crypto.ts";
import {
  buildSnapshot,
  isSnapshot,
  type MergeReport,
  mergeSnapshot,
  pruneTombstonesBefore,
  snapshotHash,
  TOMBSTONE_HORIZON_DAYS,
} from "./snapshot.ts";

export const KEY_SETTING = "backup.key"; // base64url of the 32-byte backup key, this device only
export const KEY_VERSION_SETTING = "backup.key_version";
export const RECOVERY_SETTING = "backup.recovery_key"; // shown again from Security & backup
export const LAST_HASH_SETTING = "backup.last_hash";
export const LAST_APPLIED_SETTING = "backup.last_applied";
export const LAST_SYNC_SETTING = "backup.last_sync_at";
/** When this device last heard from the backup in full (merged, already had it, or none yet). */
export const LAST_PULL_SETTING = "backup.last_pull_at";
export const DEVICE_ID_SETTING = "backup.device_id";

const KEY_VERSION = 1;

export class BackupError extends Error {
  constructor(
    public readonly code:
      | "offline"
      | "plan_required"
      | "no_backup"
      | "backup_gone"
      | "no_key"
      | "wrong_recovery_key"
      | "wrong_passkey"
      | "server",
    message: string,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

async function setting<T>(db: StackdDb, key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

async function putSetting(
  db: StackdDb,
  key: string,
  value: unknown,
  now = new Date(),
): Promise<void> {
  await db.settings.put({ key, value, updated_at: now.toISOString() });
}

export async function localKey(db: StackdDb): Promise<Uint8Array | null> {
  const text = await setting<string>(db, KEY_SETTING);
  return text ? fromBase64url(text) : null;
}

export async function deviceId(db: StackdDb): Promise<string> {
  let id = await setting<string>(db, DEVICE_ID_SETTING);
  if (!id) {
    id = crypto.randomUUID();
    await putSetting(db, DEVICE_ID_SETTING, id);
  }
  return id;
}

/** The PRF salt for this account: fixed per user, public, sent to the server with the options. */
export function prfSalt(userId: string): Uint8Array {
  return new TextEncoder().encode(`stackd-backup-prf-v1:${userId}`.padEnd(32, "=")).subarray(0, 32);
}

const aadFor = (userId: string) => `stackd-backup:${userId}`;
const wrapAad = (userId: string) => `stackd-backup-key:${userId}`;

function serverFailure(r: { error?: unknown; response: Response }): BackupError | null {
  const f = failureOf(r);
  if (!f) return null;
  if (f.status === 0) return new BackupError("offline", "You're offline.");
  if (f.code === "plan_required")
    return new BackupError("plan_required", "Backup needs Private or Connected.");
  if (f.code === "no_backup") return new BackupError("no_backup", "No backup yet.");
  if (f.code === "backup_gone")
    return new BackupError("backup_gone", "Your backups changed while restoring. Try again.");
  return new BackupError("server", f.code);
}

export interface EnableResult {
  recoveryKey: string;
  passkeyWrapped: boolean;
}

/**
 * Backup on: a fresh key, wrapped under a new recovery key (always) and under the passkey's PRF
 * output (when the browser supplied one); both copies go to the server, the key stays here.
 */
export async function enableBackup(
  db: StackdDb,
  userId: string,
  prf: { output: Uint8Array; credentialId: string } | null,
): Promise<EnableResult> {
  const key = randomBytes(32);
  const recoveryBytes = randomBytes(RECOVERY_BYTES);
  const recoverySalt = randomBytes(16);
  const recoveryWrapped = await wrapKey(
    await deriveWrappingKey(recoveryBytes, recoverySalt, WRAP_INFO),
    key,
    wrapAad(userId),
  );
  let passkeyWrapped: Uint8Array | null = null;
  let passkeySalt: Uint8Array | null = null;
  if (prf) {
    passkeySalt = randomBytes(16);
    passkeyWrapped = await wrapKey(
      await deriveWrappingKey(prf.output, passkeySalt, WRAP_INFO),
      key,
      wrapAad(userId),
    );
  }
  const r = await api.PUT("/api/backup/key", {
    body: {
      key_version: KEY_VERSION,
      recovery_wrapped: toBase64url(recoveryWrapped),
      recovery_salt: toBase64url(recoverySalt),
      passkey_wrapped: passkeyWrapped ? toBase64url(passkeyWrapped) : null,
      passkey_salt: passkeySalt ? toBase64url(passkeySalt) : null,
      passkey_credential_id: prf?.credentialId ?? null,
    },
  });
  const failure = serverFailure(r);
  if (failure) throw failure;
  const recoveryKey = formatRecoveryKey(recoveryBytes);
  await putSetting(db, KEY_SETTING, toBase64url(key));
  await putSetting(db, KEY_VERSION_SETTING, KEY_VERSION);
  await putSetting(db, RECOVERY_SETTING, recoveryKey);
  await putSetting(db, LAST_HASH_SETTING, null);
  return { recoveryKey, passkeyWrapped: passkeyWrapped !== null };
}

/** Backup off: the server forgets the key copies and every blob; this device forgets its key. */
export async function disableBackup(db: StackdDb): Promise<void> {
  const r = await api.DELETE("/api/backup");
  const failure = serverFailure(r);
  if (failure) throw failure;
  for (const key of [
    KEY_SETTING,
    KEY_VERSION_SETTING,
    RECOVERY_SETTING,
    LAST_HASH_SETTING,
    LAST_APPLIED_SETTING,
    LAST_SYNC_SETTING,
    LAST_PULL_SETTING,
    // the pruned-removals record stays: those tombstones are gone whatever happens next
  ])
    await db.settings.delete(key);
}

export interface PushResult {
  uploaded: boolean;
  backupId: string | null;
}

/** Encrypt this device's snapshot and upload it, unless the server already has this exact data. */
export async function pushBackup(
  db: StackdDb,
  userId: string,
  rulesVersion: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<PushResult> {
  const key = await localKey(db);
  if (!key) throw new BackupError("no_key", "Backup is off on this device.");
  const now = options.now ?? new Date();
  const snapshot = await buildSnapshot(db, { rulesVersion, deviceId: await deviceId(db), now });
  const hash = await snapshotHash(snapshot);
  if (!options.force && (await setting<string>(db, LAST_HASH_SETTING)) === hash)
    return { uploaded: false, backupId: null };
  const blob = await encryptJson(key, snapshot, aadFor(userId));
  const r = await api.PUT("/api/backup/blob", {
    body: {
      ciphertext: toBase64url(blob),
      key_version: (await setting<number>(db, KEY_VERSION_SETTING)) ?? KEY_VERSION,
      snapshot_at: snapshot.created_at,
    },
  });
  const failure = serverFailure(r);
  if (failure) throw failure;
  await putSetting(db, LAST_HASH_SETTING, hash, now);
  await putSetting(db, LAST_APPLIED_SETTING, r.data?.id ?? null, now);
  return { uploaded: true, backupId: r.data?.id ?? null };
}

export interface PullResult {
  applied: boolean;
  backupId: string | null;
  report: MergeReport | null;
}

/** How many copies a pull steps back through before giving up (the server keeps at most 10). */
const MAX_STEPS = 10;
/** How often a walk starts again from the newest when the copy it stood on was pruned. */
const MAX_RESTARTS = 2;

/**
 * Fetch the newest backup and merge it here, once per backup id. A copy this key can't open
 * (a bad upload, say from a stolen session) is stepped past to the one before it, so older
 * good copies the server keeps still restore (October 24, 2026).
 */
export async function pullBackup(
  db: StackdDb,
  userId: string,
  key?: Uint8Array,
  now: Date = new Date(),
): Promise<PullResult> {
  const k = key ?? (await localKey(db));
  if (!k) throw new BackupError("no_key", "Backup is off on this device.");
  const lastApplied = await setting<string>(db, LAST_APPLIED_SETTING);
  let newest: string | null = null;
  let before: string | undefined;
  // Copies this key could not open: after a restart the walk steps past them without asking
  // for their bytes again (invariant 20).
  const unreadable = new Set<string>();
  let restarts = 0;
  for (let step = 0; step < MAX_STEPS * (MAX_RESTARTS + 1); step++) {
    const r = await api.GET("/api/backup/blob/latest", {
      params: { query: before ? { before } : {} },
    });
    const failure = serverFailure(r);
    if (failure) {
      if (failure.code === "no_backup") break;
      // The copy the walk stood on was pruned (another device uploaded): start from the newest.
      if (failure.code === "backup_gone" && restarts < MAX_RESTARTS) {
        restarts += 1;
        before = undefined;
        newest = null;
        continue;
      }
      throw failure;
    }
    const row = r.data;
    if (!row) break;
    newest ??= row.id;
    if (unreadable.has(row.id)) {
      before = row.id;
      continue;
    }
    if (row.id === lastApplied) {
      // Already merged; anything above it was unreadable, so don't walk past it again.
      if (newest !== lastApplied) await putSetting(db, LAST_APPLIED_SETTING, newest);
      await putSetting(db, LAST_PULL_SETTING, now.toISOString(), now);
      return { applied: false, backupId: row.id, report: null };
    }
    let snapshot: unknown = null;
    try {
      snapshot = await decryptJson<unknown>(k, fromBase64url(row.ciphertext), aadFor(userId));
    } catch (err) {
      if (!(err instanceof CryptoError)) throw err;
    }
    if (!isSnapshot(snapshot)) {
      unreadable.add(row.id);
      before = row.id;
      continue;
    }
    const report = await mergeSnapshot(db, snapshot);
    await putSetting(db, LAST_APPLIED_SETTING, newest);
    await putSetting(db, LAST_PULL_SETTING, now.toISOString(), now);
    return { applied: true, backupId: row.id, report };
  }
  if (newest === null) {
    await putSetting(db, LAST_PULL_SETTING, now.toISOString(), now);
    return { applied: false, backupId: null, report: null };
  }
  throw new CryptoError("bad_ciphertext", "Not a Qash backup.");
}

export interface SyncResult {
  pulled: PullResult;
  pushed: PushResult;
}

/**
 * Pull, merge, then push when this device holds something the server does not; then prune
 * old removals, so the upload just made still carried them (invariant 24).
 */
export async function syncBackup(
  db: StackdDb,
  userId: string,
  rulesVersion: string,
  now = new Date(),
): Promise<SyncResult> {
  const pulled = await pullBackup(db, userId, undefined, now);
  const pushed = await pushBackup(db, userId, rulesVersion, { now });
  await putSetting(db, LAST_SYNC_SETTING, now.toISOString(), now);
  await pruneOldTombstones(db, now);
  return { pulled, pushed };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Drops removals older than TOMBSTONE_HORIZON_DAYS, only while backup is on here and the last
 * full pull is within the horizon (an older one may not have seen a newer state). With backup
 * off nothing is pruned: a later restore that merges this device with another must still tell
 * a removal here from a row it never had. Household sharing never reads tombstones, so it
 * changes nothing here. Returns how many went.
 */
export async function pruneOldTombstones(db: StackdDb, now: Date = new Date()): Promise<number> {
  if (!(await localKey(db))) return 0;
  const lastPull = await setting<string>(db, LAST_PULL_SETTING);
  const horizonMs = TOMBSTONE_HORIZON_DAYS * DAY_MS;
  if (!lastPull) return 0;
  const pulledAt = Date.parse(lastPull);
  if (!Number.isFinite(pulledAt) || now.getTime() - pulledAt > horizonMs) return 0;
  return pruneTombstonesBefore(db, new Date(now.getTime() - horizonMs).toISOString());
}

interface KeyRecord {
  key_version: number;
  recovery_wrapped: string;
  recovery_salt: string;
  passkey_wrapped: string | null;
  passkey_salt: string | null;
  passkey_credential_id: string | null;
}

async function keepKey(db: StackdDb, key: Uint8Array, record: KeyRecord): Promise<void> {
  await putSetting(db, KEY_SETTING, toBase64url(key));
  await putSetting(db, KEY_VERSION_SETTING, record.key_version);
  await putSetting(db, LAST_HASH_SETTING, null);
}

/** A new device: open the backup key with the recovery key, keep it here, merge the latest backup. */
export async function restoreWithRecoveryKey(
  db: StackdDb,
  userId: string,
  record: KeyRecord,
  recoveryKeyText: string,
): Promise<PullResult> {
  let key: Uint8Array;
  try {
    const bytes = parseRecoveryKey(recoveryKeyText);
    const wrapping = await deriveWrappingKey(bytes, fromBase64url(record.recovery_salt), WRAP_INFO);
    key = await unwrapKey(wrapping, fromBase64url(record.recovery_wrapped), wrapAad(userId));
  } catch (err) {
    if (err instanceof CryptoError)
      throw new BackupError("wrong_recovery_key", "That recovery key doesn't match.");
    throw err;
  }
  const pulled = await pullBackup(db, userId, key);
  await keepKey(db, key, record);
  await putSetting(db, RECOVERY_SETTING, recoveryKeyText.trim().toUpperCase());
  return pulled;
}

/** A new device with the passkey's PRF output: open the passkey-wrapped copy. */
export async function restoreWithPasskey(
  db: StackdDb,
  userId: string,
  record: KeyRecord,
  prfOutput: Uint8Array,
): Promise<PullResult> {
  if (!record.passkey_wrapped || !record.passkey_salt)
    throw new BackupError("wrong_passkey", "This backup has no passkey copy of its key.");
  let key: Uint8Array;
  try {
    const wrapping = await deriveWrappingKey(
      prfOutput,
      fromBase64url(record.passkey_salt),
      WRAP_INFO,
    );
    key = await unwrapKey(wrapping, fromBase64url(record.passkey_wrapped), wrapAad(userId));
  } catch (err) {
    if (err instanceof CryptoError)
      throw new BackupError("wrong_passkey", "This passkey doesn't open the backup.");
    throw err;
  }
  const pulled = await pullBackup(db, userId, key);
  await keepKey(db, key, record);
  return pulled;
}
