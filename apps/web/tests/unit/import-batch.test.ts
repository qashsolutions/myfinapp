/**
 * Several files at once (owner decisions, November 16, 2026): the plan's limits in the order
 * picked, and which statements can go in without asking.
 */
import type { Account } from "../../src/data/db.ts";
import { accountFor, limitsNote, MB, planBatch } from "../../src/features/imports/batch.ts";
import type { ParsedFile } from "../../src/features/imports/importFlow.ts";

const PRIVATE = { import_files_max: 5, import_file_mb: 2, import_batch_mb: 10 };
const CONNECTED = { import_files_max: 10, import_file_mb: 2, import_batch_mb: 20 };
const file = (name: string, mb: number) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: Math.round(mb * MB) });
  return f;
};

describe("planBatch", () => {
  it("Private reads 5: the rest wait for the next batch, in the order picked", () => {
    const rows = planBatch(
      Array.from({ length: 7 }, (_, i) => file(`m${i + 1}.pdf`, 1)),
      PRIVATE,
    );
    expect(rows.map((r) => r.status)).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "waiting",
      "later",
      "later",
    ]);
    expect(limitsNote(rows, PRIVATE, "Private")).toBe(
      "You picked 7 files. Private reads 5 at a time and 10 MB in all, so 2 wait for the next batch.",
    );
  });

  it("a file over 2 MB is too big and doesn't count toward the batch", () => {
    const rows = planBatch(
      [file("jan.pdf", 0.9), file("annual.pdf", 3.4), file("feb.pdf", 1.1)],
      PRIVATE,
    );
    expect(rows.map((r) => r.status)).toEqual(["waiting", "too_big", "waiting"]);
    expect(rows[1]?.note).toBe(
      "3.4 MB, too big: 2 MB a file. Download one month or a CSV instead.",
    );
    expect(limitsNote(rows, PRIVATE, "Private")).toBeNull();
  });

  it("Connected reads 10, and a batch never passes its size", () => {
    expect(
      planBatch(
        Array.from({ length: 12 }, (_, i) => file(`f${i}.pdf`, 1.9)),
        CONNECTED,
      ).filter((r) => r.status === "waiting"),
    ).toHaveLength(10);
    const tight = { import_files_max: 10, import_file_mb: 2, import_batch_mb: 3 };
    expect(
      planBatch([file("a.pdf", 1.5), file("b.pdf", 1.6), file("c.pdf", 1.4)], tight).map(
        (r) => r.status,
      ),
      // Keeps the files that fit, in the order picked: the third still fits after the second.
    ).toEqual(["waiting", "later", "waiting"]);
  });
});

describe("accountFor", () => {
  const acct = (id: string, last4: string | null): Account => ({
    id,
    label: id,
    type: "checking",
    last4,
    institution: null,
    currency: "USD",
    created_at: "2026-10-01T00:00:00Z",
  });
  const ofx = (last4: string | null) =>
    ({
      format: "ofx",
      ofx: {
        account: { last4, type: null, institution: null },
        rows: [],
        ledger: null,
        period: { start: null, end: null },
        skipped: 0,
      },
      rowCount: 0,
    }) as unknown as ParsedFile;

  it("the only account with the statement's last four", () => {
    expect(
      accountFor(ofx("4821"), [acct("a", "4821"), acct("b", "1173")], new Set(), null)?.id,
    ).toBe("a");
  });
  it("none when two accounts share it, the statement names none, or it's a CSV", () => {
    expect(
      accountFor(ofx("4821"), [acct("a", "4821"), acct("b", "4821")], new Set(), null),
    ).toBeNull();
    expect(accountFor(ofx(null), [acct("a", "4821")], new Set(), null)).toBeNull();
    expect(
      accountFor(
        { format: "csv", rowCount: 1 } as ParsedFile,
        [acct("a", "4821")],
        new Set(),
        null,
      ),
    ).toBeNull();
  });
  it("none when the plan's statement accounts are used up by other accounts", () => {
    expect(accountFor(ofx("4821"), [acct("a", "4821")], new Set(["z"]), 1)).toBeNull();
    expect(accountFor(ofx("4821"), [acct("a", "4821")], new Set(["a"]), 1)?.id).toBe("a");
  });
});
