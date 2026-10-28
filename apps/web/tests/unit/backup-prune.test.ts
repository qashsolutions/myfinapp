/**
 * Invariant 24: old removals are pruned without bringing anything back. A device drops
 * tombstones older than TOMBSTONE_HORIZON_DAYS only after a recent pull, records how far it
 * pruned, and a merge never adds a row from another device that is older than that record
 * (it can no longer tell whether the row was removed here). Absence never deletes.
 */
import { randomBytes, toBase64url } from "../../src/data/backup/crypto.ts";
import {
  buildSnapshot,
  mergeSnapshot,
  PRUNED_BEFORE_SETTING,
  recordDeletion,
  TOMBSTONE_HORIZON_DAYS,
} from "../../src/data/backup/snapshot.ts";
import {
  KEY_SETTING,
  LAST_PULL_SETTING,
  pruneOldTombstones,
  syncBackup,
} from "../../src/data/backup/sync.ts";
import { type Entry, openDb, type StackdDb } from "../../src/data/db.ts";
import { type FakeBackup, installFakeApi, readySession } from "../fakeApi.ts";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const OLD = "2026-03-01T10:00:00.000Z"; // well past the 180-day horizon
const OLDER = "2026-02-01T10:00:00.000Z";
const RECENT = "2026-10-20T10:00:00.000Z";

function entry(id: string, stamp: string, merchant = "Corner Market"): Entry {
  return {
    id,
    date: stamp.slice(0, 10),
    direction: "out",
    amount_cents: 1250,
    merchant,
    raw_description: merchant,
    clean_description: merchant.toUpperCase(),
    import_id: null,
    transfer_pair_id: null,
    category_id: null,
    account_id: "cash",
    source: "manual",
    is_transfer: false,
    is_recurring: false,
    receipt_id: null,
    split_parent_id: null,
    created_at: stamp,
    updated_at: stamp,
  } as Entry;
}

async function fresh(name: string): Promise<StackdDb> {
  const db = openDb(name);
  await db.delete();
  await db.open();
  return db;
}

async function backupOn(db: StackdDb, lastPull: string | null) {
  await db.settings.put({ key: KEY_SETTING, value: toBase64url(randomBytes(32)), updated_at: "" });
  if (lastPull) await db.settings.put({ key: LAST_PULL_SETTING, value: lastPull, updated_at: "" });
}

describe("pruning old removals", () => {
  it("the horizon is 180 days", () => {
    expect(TOMBSTONE_HORIZON_DAYS).toBe(180);
  });

  it("drops tombstones past the horizon after a recent pull, keeps newer ones, and records how far", async () => {
    const db = openDb("u1");
    await backupOn(db, "2026-10-28T11:00:00.000Z");
    await recordDeletion(db, "entries", ["old1"], new Date(OLDER));
    await recordDeletion(db, "entries", ["old2"], new Date(OLD));
    await recordDeletion(db, "entries", ["new1"], new Date(RECENT));
    expect(await pruneOldTombstones(db, NOW)).toBe(2);
    expect((await db.tombstones.toArray()).map((t) => t.id)).toEqual(["new1"]);
    expect((await db.settings.get(PRUNED_BEFORE_SETTING))?.value).toBe(OLD);
    // The snapshot says how far this device pruned (and the record itself never syncs as a setting)
    const snap = await buildSnapshot(db, { rulesVersion: "t", deviceId: "A", now: NOW });
    expect(snap.tombstones_pruned_before).toBe(OLD);
    expect(snap.tables.settings.map((s) => s.key)).not.toContain(PRUNED_BEFORE_SETTING);
    // Pruning again with nothing old leaves the record where it was
    expect(await pruneOldTombstones(db, NOW)).toBe(0);
    expect((await db.settings.get(PRUNED_BEFORE_SETTING))?.value).toBe(OLD);
  });

  it("keeps everything when the last pull is older than the horizon, or there never was one", async () => {
    const db = openDb("u1");
    await backupOn(db, "2026-04-01T00:00:00.000Z");
    await recordDeletion(db, "entries", ["old1"], new Date(OLD));
    expect(await pruneOldTombstones(db, NOW)).toBe(0);
    await db.settings.delete(LAST_PULL_SETTING);
    expect(await pruneOldTombstones(db, NOW)).toBe(0);
    expect(await db.tombstones.count()).toBe(1);
    expect(await db.settings.get(PRUNED_BEFORE_SETTING)).toBeUndefined();
  });

  it("keeps everything with backup off: a later restore must still merge exactly", async () => {
    const db = openDb("u1");
    await recordDeletion(db, "entries", ["old1"], new Date(OLD));
    await db.settings.put({ key: LAST_PULL_SETTING, value: NOW.toISOString(), updated_at: "" });
    expect(await pruneOldTombstones(db, NOW)).toBe(0);
    expect(await db.tombstones.count()).toBe(1);
  });

  it("keeps the removals of tables whose rows may carry no timestamp", async () => {
    const db = openDb("u1");
    await backupOn(db, NOW.toISOString());
    await recordDeletion(db, "budget_lines", ["l1"], new Date(OLD));
    await recordDeletion(db, "categories", ["c1"], new Date(OLD));
    await recordDeletion(db, "goal_milestones", ["g1:5000"], new Date(OLD));
    await recordDeletion(db, "entries", ["e1"], new Date(OLD));
    expect(await pruneOldTombstones(db, NOW)).toBe(1);
    expect((await db.tombstones.toArray()).map((t) => t.table).sort()).toEqual([
      "budget_lines",
      "categories",
      "goal_milestones",
    ]);
  });

  it("a stale device's old row is not brought back on a device that pruned; a fresh row still merges", async () => {
    // A stale device still holds e-old, removed here long ago; it also made e-new recently.
    const stale = await fresh("u1-stale");
    await stale.entries.bulkAdd([entry("e-old", OLDER, "Gone"), entry("e-new", RECENT, "Bakery")]);
    const staleSnap = await buildSnapshot(stale, { rulesVersion: "t", deviceId: "S", now: NOW });

    const here = openDb("u1");
    await backupOn(here, NOW.toISOString());
    await recordDeletion(here, "entries", ["e-old"], new Date(OLD));
    await here.entries.add(entry("e-mine", OLDER, "Mine"));
    expect(await pruneOldTombstones(here, NOW)).toBe(1);

    const report = await mergeSnapshot(here, staleSnap);
    expect(report).toMatchObject({ added: 1, stale: 1 });
    expect(await here.entries.get("e-old")).toBeUndefined();
    expect(await here.entries.get("e-new")).toMatchObject({ merchant: "Bakery" });

    // Absence never deletes: a snapshot that pruned further and lacks e-mine leaves it alone
    const further = await buildSnapshot(stale, { rulesVersion: "t", deviceId: "S", now: NOW });
    further.tombstones_pruned_before = RECENT;
    expect(further.tables.entries.map((e) => e.id)).not.toContain("e-mine");
    await mergeSnapshot(here, further);
    expect(await here.entries.get("e-mine")).toMatchObject({ merchant: "Mine" });
    // ...and this device takes the further record, so later merges are as careful
    expect((await here.settings.get(PRUNED_BEFORE_SETTING))?.value).toBe(RECENT);
    await stale.delete();
  });

  it("a device restored from a pruned backup takes its record, so a stale device cannot bring a removal back there", async () => {
    const pruned = openDb("u1");
    await backupOn(pruned, NOW.toISOString());
    await pruned.entries.add(entry("e-kept", OLDER, "Kept"));
    await recordDeletion(pruned, "entries", ["e-old"], new Date(OLD));
    await pruneOldTombstones(pruned, NOW);
    const backup = await buildSnapshot(pruned, { rulesVersion: "t", deviceId: "A", now: NOW });

    const restored = await fresh("u1-new");
    // The first merge on a new device brings everything, old rows included
    expect(await mergeSnapshot(restored, backup)).toMatchObject({ added: 1, stale: 0 });
    expect(await restored.entries.get("e-kept")).toBeDefined();
    expect((await restored.settings.get(PRUNED_BEFORE_SETTING))?.value).toBe(OLD);

    const stale = await fresh("u1-stale");
    await stale.entries.add(entry("e-old", OLDER, "Gone"));
    await mergeSnapshot(
      restored,
      await buildSnapshot(stale, { rulesVersion: "t", deviceId: "S", now: NOW }),
    );
    expect(await restored.entries.get("e-old")).toBeUndefined();
    await stale.delete();
    await restored.delete();
  });

  it("a sync prunes after it pulled and pushed, and the next upload is smaller", async () => {
    const db = openDb("u1");
    const key = randomBytes(32);
    await db.settings.put({ key: KEY_SETTING, value: toBase64url(key), updated_at: "" });
    await recordDeletion(db, "entries", ["old1"], new Date(OLD));
    const backup: FakeBackup = { key: { key_version: 1 }, blobs: [] };
    installFakeApi({ session: readySession(), backup });
    await syncBackup(db, "u1", "t", NOW);
    // The push carried the old removal (the pull came first), then it went
    expect(backup.blobs).toHaveLength(1);
    expect(await db.tombstones.count()).toBe(0);
    expect((await db.settings.get(LAST_PULL_SETTING))?.value).toBe(NOW.toISOString());
    expect((await db.settings.get(PRUNED_BEFORE_SETTING))?.value).toBe(OLD);
    await syncBackup(db, "u1", "t", new Date("2026-10-28T12:05:00.000Z"));
    expect(backup.blobs).toHaveLength(2);
  });
});
