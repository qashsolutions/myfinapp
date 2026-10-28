import {
  decryptJson,
  deriveWrappingKey,
  encryptJson,
  formatRecoveryKey,
  parseRecoveryKey,
  randomBytes,
  unwrapKey,
  WRAP_INFO,
  wrapKey,
} from "../../src/data/backup/crypto.ts";
import {
  buildSnapshot,
  mergeSnapshot,
  recordDeletion,
  snapshotHash,
} from "../../src/data/backup/snapshot.ts";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import {
  changeMilestones,
  ensureMilestones,
  stampMilestones,
} from "../../src/features/goals/useGoals.ts";

const T0 = "2026-10-01T10:00:00.000Z";
const T1 = "2026-10-02T10:00:00.000Z";
const T2 = "2026-10-03T10:00:00.000Z";

function entry(id: string, updated_at: string, merchant = "Corner Market") {
  return {
    id,
    date: "2026-10-01",
    direction: "out" as const,
    amount_cents: 1250,
    merchant,
    raw_description: merchant,
    clean_description: merchant.toUpperCase(),
    import_id: null,
    transfer_pair_id: null,
    category_id: null,
    account_id: "cash",
    source: "manual" as const,
    is_transfer: false,
    is_recurring: false,
    receipt_id: null,
    split_parent_id: null,
    created_at: T0,
    updated_at,
  };
}

describe("backup crypto", () => {
  it("round-trips JSON under a key and refuses the wrong key or the wrong owner", async () => {
    const key = randomBytes(32);
    const blob = await encryptJson(key, { hello: "world", n: 1 }, "stackd-backup:u1");
    expect(blob[0]).toBe(1);
    expect(await decryptJson(key, blob, "stackd-backup:u1")).toEqual({ hello: "world", n: 1 });
    await expect(decryptJson(randomBytes(32), blob, "stackd-backup:u1")).rejects.toMatchObject({
      code: "wrong_key",
    });
    await expect(decryptJson(key, blob, "stackd-backup:u2")).rejects.toMatchObject({
      code: "wrong_key",
    });
    const same = await encryptJson(key, { hello: "world", n: 1 }, "stackd-backup:u1");
    expect(same).not.toEqual(blob); // a fresh nonce every time
  });

  it("a recovery key reads back from paper, and unwraps only the key it wrapped", async () => {
    const recovery = randomBytes(20);
    const text = formatRecoveryKey(recovery);
    expect(text).toMatch(/^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
    expect(parseRecoveryKey(text)).toEqual(recovery);
    expect(parseRecoveryKey(text.toLowerCase().replace(/-/g, " "))).toEqual(recovery);
    expect(() => parseRecoveryKey("ABCD")).toThrow(/32 characters/);

    const salt = randomBytes(16);
    const key = randomBytes(32);
    const wrapped = await wrapKey(await deriveWrappingKey(recovery, salt, WRAP_INFO), key, "k:u1");
    expect(
      await unwrapKey(await deriveWrappingKey(recovery, salt, WRAP_INFO), wrapped, "k:u1"),
    ).toEqual(key);
    await expect(
      unwrapKey(await deriveWrappingKey(randomBytes(20), salt, WRAP_INFO), wrapped, "k:u1"),
    ).rejects.toMatchObject({ code: "wrong_key" });
  });
});

describe("snapshots and merging", () => {
  it("adds what is missing, keeps the newer copy, and honours deletions on both sides", async () => {
    const a = openDb("u1");
    await seedDefaults(a);
    await a.entries.bulkAdd([entry("e1", T0), entry("e2", T0, "Old name")]);
    await a.goals.add({
      id: "g1",
      kind: "save",
      title: "Travel",
      target_cents: 50000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: T0,
      updated_at: T0,
    });
    const first = await buildSnapshot(a, { rulesVersion: "t", deviceId: "A", now: new Date(T1) });
    expect(first.tables.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(first.tables.categories.length).toBeGreaterThan(0);
    expect(first.tombstones).toEqual([]);
    const hash = await snapshotHash(first);
    expect(await snapshotHash(await buildSnapshot(a, { rulesVersion: "t", deviceId: "B" }))).toBe(
      hash,
    );

    // "Device B" starts from the snapshot, then edits e2, adds e3 and removes e1.
    const b = openDb("u1b");
    await b.delete();
    await b.open();
    await seedDefaults(b);
    const report = await mergeSnapshot(b, first);
    expect(report).toMatchObject({ added: 3, removed: 0 }); // e1, e2, g1 (categories were seeded alike)
    await b.entries.put({ ...entry("e2", T2, "New name") });
    await b.entries.add(entry("e3", T2, "Bakery"));
    await b.entries.delete("e1");
    await recordDeletion(b, "entries", ["e1"], new Date(T2));
    const second = await buildSnapshot(b, { rulesVersion: "t", deviceId: "B", now: new Date(T2) });
    expect(second.tombstones).toEqual([{ table: "entries", id: "e1", deleted_at: T2 }]);

    // Back on A: e1 goes, e2 takes the newer name, e3 arrives; a local newer edit wins.
    await a.entries.put({ ...entry("e2", "2026-10-04T00:00:00.000Z", "Local newest") });
    const back = await mergeSnapshot(a, second);
    expect(back).toMatchObject({ added: 1, updated: 0, removed: 1 });
    expect((await a.entries.toArray()).map((e) => [e.id, e.merchant]).sort()).toEqual([
      ["e2", "Local newest"],
      ["e3", "Bakery"],
    ]);
    expect(await a.tombstones.get(["entries", "e1"])).toMatchObject({ id: "e1" });
    // A re-send of the old snapshot cannot resurrect e1
    const again = await mergeSnapshot(a, first);
    expect(again.added).toBe(0);
    expect(await a.entries.get("e1")).toBeUndefined();
    await b.delete();
  });

  it("a milestone removed and added back survives a merge carrying the old removal, and is not stamped again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(T0));
      const a = openDb("u1");
      const goal = {
        id: "g1",
        kind: "save" as const,
        title: "Travel",
        target_cents: 50000,
        target_days: null,
        label: null,
        category_id: null,
        start_date: "2026-10-01",
        end_date: null,
        baseline_cents: null,
        group_id: null,
        status: "active" as const,
        milestones_bps: [5000],
        created_at: T0,
        updated_at: T0,
      };
      await a.goals.add(goal);
      await ensureMilestones(a, goal, [{ bps: 5000, target_cents: 25000 }]);
      // Removed on the goal screen; another device's snapshot carries that removal
      vi.setSystemTime(new Date(T1));
      await changeMilestones(a, goal, [], 30000, "2026-10-02");
      const withRemoval = await buildSnapshot(a, { rulesVersion: "t", deviceId: "B" });
      expect(withRemoval.tombstones).toEqual([
        { table: "goal_milestones", id: "g1:5000", deleted_at: T1 },
      ]);
      // Added back: already passed, so recorded as reached today without a cheer
      vi.setSystemTime(new Date(T2));
      const now = { ...goal, milestones_bps: [] };
      await changeMilestones(a, now, [5000], 30000, "2026-10-03");
      expect(await a.tombstones.get(["goal_milestones", "g1:5000"])).toBeUndefined();
      await mergeSnapshot(a, withRemoval);
      expect(await a.goal_milestones.get("g1:5000")).toMatchObject({
        reached_at: "2026-10-03",
        updated_at: T2,
      });
      // The goal screen's stamp finds it reached already: no second milestone_reached
      const stamped = await stampMilestones(
        a,
        { ...goal, milestones_bps: [5000] },
        [{ bps: 5000, target_cents: 25000, reached: true }],
        "2026-10-03",
      );
      expect(stamped).toEqual([]);
      // And the row travels to a device that still holds the removal
      const b = openDb("u1b");
      await b.delete();
      await b.open();
      await mergeSnapshot(b, withRemoval);
      await mergeSnapshot(b, await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" }));
      expect(await b.goal_milestones.get("g1:5000")).toMatchObject({ reached_at: "2026-10-03" });
      await b.delete();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a row a unique index already holds is skipped and counted; any other failure stops the merge", async () => {
    const a = openDb("u1");
    await a.entries.add({ ...entry("e1", T0), fingerprint: "fp-1" });
    const snap = await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" });
    // The same import row under another id: the fingerprint index refuses it
    snap.tables.entries = [{ ...entry("e2", T0), fingerprint: "fp-1" }];
    const report = await mergeSnapshot(a, snap);
    expect(report).toMatchObject({ added: 0, skipped: 1 });
    expect(await a.entries.get("e2")).toBeUndefined();
    // A row the database cannot store at all is an error, not a silent skip
    const { id: _id, ...keyless } = entry("e3", T0, "No key");
    snap.tables.entries = [keyless];
    await expect(mergeSnapshot(a, snap)).rejects.toMatchObject({ name: "DataError" });
    expect(await a.entries.count()).toBe(1);
  });

  it("a newer row a unique index already holds under another id is skipped too, and the merge goes on", async () => {
    const a = openDb("u1");
    await a.entries.bulkAdd([
      { ...entry("e1", T0), fingerprint: "fp-1" },
      { ...entry("e2", T0), fingerprint: "fp-2" },
    ]);
    const snap = await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" });
    // Another device holds e2 newer, under the fingerprint e1 has here (two devices syncing
    // one bank connection suffix their fingerprints differently): the put clashes
    snap.tables.entries = [
      { ...entry("e2", T1, "Clash"), fingerprint: "fp-1" },
      { ...entry("e3", T1, "After"), fingerprint: "fp-3" },
    ];
    const report = await mergeSnapshot(a, snap);
    expect(report).toMatchObject({ added: 1, updated: 0, skipped: 1 });
    expect((await a.entries.get("e2"))?.merchant).toBe("Corner Market");
    expect((await a.entries.get("e3"))?.merchant).toBe("After");
  });

  it("builds the snapshot in one read transaction, so a write cannot land halfway", async () => {
    const a = openDb("u1");
    await a.entries.add(entry("e1", T0));
    const spy = vi.spyOn(a, "transaction");
    await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("r");
    spy.mockRestore();
  });

  it("leaves device-only settings out of the snapshot", async () => {
    const a = openDb("u1");
    await a.settings.bulkPut([
      { key: "backup.key", value: "secret", updated_at: T0 },
      { key: "household.key", value: "secret", updated_at: T0 },
      { key: "pay", value: { amount_cents: 1 }, updated_at: T0 },
    ]);
    const snap = await buildSnapshot(a, { rulesVersion: "t", deviceId: "A" });
    expect(snap.tables.settings.map((s) => s.key)).toEqual(["pay"]);
    expect(JSON.stringify(snap)).not.toContain("secret");
  });
});
