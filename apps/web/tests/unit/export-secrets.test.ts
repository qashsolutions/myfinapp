/**
 * Invariant 25 (October 29, 2026): the export holds everything the person made, and never a
 * key to it. Whoever holds the ZIP must not be able to open the server backups or the
 * household's shared blobs with it, nor anything else that only this device should hold.
 */

import { buildSnapshot } from "../../src/data/backup/snapshot.ts";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { collectExport, EXPORT_LEFT_OUT_SETTINGS } from "../../src/data/export.ts";

const SECRETS: Record<string, string> = {
  "backup.key": "BACKUPKEYSECRET1",
  "backup.recovery_key": "RECOVERYSECRET2",
  "backup.key_version": "KEYVERSIONSECRET8",
  "backup.device_id": "DEVICEIDSECRET3",
  "household.key": "HOUSEHOLDSECRET4",
  "alerts.tag_salt": "TAGSALTSECRET5",
  "alerts.last_hash": "LASTHASHSECRET6",
  "linking.cursor.conn-1": "CURSORSECRET7",
};

async function seeded() {
  const db = openDb("u1");
  await seedDefaults(db);
  const at = "2026-10-29T09:00:00.000Z";
  for (const [key, value] of Object.entries(SECRETS))
    await db.settings.put({ key, value, updated_at: at });
  // An ordinary preference still goes in the export.
  await db.settings.put({ key: "receipts.retention", value: "1y", updated_at: at });
  return db;
}

const text = (files: { name: string; data: Uint8Array }[]) =>
  files.map((f) => new TextDecoder().decode(f.data)).join("\n");

describe("the export leaves out this device's secrets", () => {
  it("has no backup, household, alert-salt or linking-cursor value anywhere in the ZIP", async () => {
    const db = await seeded();
    const files = await collectExport(db, null, "2026-10-29T09:00:00.000Z");
    const all = text(files);
    for (const [key, value] of Object.entries(SECRETS)) {
      expect(all, key).not.toContain(value);
      expect(all, key).not.toContain(`"${key}"`);
    }
    const settings = JSON.parse(
      new TextDecoder().decode(files.find((f) => f.name === "settings.json")?.data),
    ) as { settings: { key: string; value: unknown }[] };
    expect(settings.settings.find((s) => s.key === "receipts.retention")?.value).toBe("1y");
  });

  it("names every left-out key in one list", () => {
    for (const key of Object.keys(SECRETS))
      expect(
        EXPORT_LEFT_OUT_SETTINGS.some((p) => (p.endsWith(".") ? key.startsWith(p) : key === p)),
        key,
      ).toBe(true);
  });

  it("the backup snapshot never carries the backup or household key either", async () => {
    const db = await seeded();
    const snap = await buildSnapshot(db, { rulesVersion: "t", deviceId: "A" });
    const all = JSON.stringify(snap);
    for (const key of ["backup.key", "backup.recovery_key", "household.key"])
      expect(all, key).not.toContain(SECRETS[key]);
  });
});
