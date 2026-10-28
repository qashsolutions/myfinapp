/**
 * Invariant 20: a restore that steps back past copies it can't open survives a copy being
 * pruned mid-walk (another device uploaded meanwhile). "That copy is gone" (409 backup_gone)
 * starts the walk again from the newest; it never reads as "no backups exist".
 */
import { encryptJson, randomBytes, toBase64url } from "../../src/data/backup/crypto.ts";
import { buildSnapshot } from "../../src/data/backup/snapshot.ts";
import { KEY_SETTING, pullBackup } from "../../src/data/backup/sync.ts";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { type FakeBackup, type FakeBackupBlob, installFakeApi, readySession } from "../fakeApi.ts";

const USER = "u1";

function blob(id: string, ciphertext: string): FakeBackupBlob {
  return {
    id,
    ciphertext,
    key_version: 1,
    snapshot_at: "2026-10-27T10:00:00Z",
    created_at: "2026-10-27T10:00:00Z",
    device_label: "Safari on iPhone",
  };
}

it("a copy pruned mid-walk starts the walk again and still restores the good copy", async () => {
  const db = openDb(USER);
  await seedDefaults(db);
  await db.entries.add({
    id: "e1",
    date: "2026-10-20",
    amount_cents: 1250,
    direction: "out",
    merchant: "Corner Market",
    clean_description: "CORNER MARKET",
    raw_description: null,
    category_id: "cat-groceries",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  } as Entry);
  const key = randomBytes(32);
  const good = toBase64url(
    await encryptJson(
      key,
      await buildSnapshot(db, { rulesVersion: "test", deviceId: "d1" }),
      `stackd-backup:${USER}`,
    ),
  );
  await db.entries.clear(); // this device has nothing yet
  await db.settings.put({ key: KEY_SETTING, value: toBase64url(key), updated_at: "" });

  const backup: FakeBackup = {
    key: { key_version: 1 },
    blobs: [blob("good", good), blob("junk1", "AAAA"), blob("junk2", "AAAA")],
  };
  installFakeApi({ session: readySession(), backup });
  // Another device uploads while this one is stepping back: after the first answer, the
  // copies the walk is standing on are pruned, the good one (a day's newest) is kept.
  const fakeFetch = globalThis.fetch;
  let latestCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fakeFetch(input, init);
    if (String(input instanceof Request ? input.url : input).includes("/api/backup/blob/latest")) {
      latestCalls += 1;
      if (latestCalls === 1) backup.blobs = [blob("good", good), blob("junk3", "AAAA")];
    }
    return res;
  });
  try {
    const pulled = await pullBackup(db, USER);
    expect(pulled).toMatchObject({ applied: true, backupId: "good" });
    expect(await db.entries.get("e1")).toMatchObject({ merchant: "Corner Market" });
  } finally {
    vi.unstubAllGlobals();
  }
});
