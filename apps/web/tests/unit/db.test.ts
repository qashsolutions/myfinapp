import {
  closeDb,
  deleteDb,
  type Entry,
  entriesBetween,
  newId,
  openDb,
  seedDefaults,
} from "../../src/data/db.ts";
import { DEFAULT_ACCOUNT, DEFAULT_CATEGORIES } from "../../src/data/defaults.ts";

function entry(over: Partial<Entry>): Entry {
  const now = "2026-10-10T12:00:00.000Z";
  return {
    id: newId(),
    date: "2026-10-09",
    amount_cents: 4217,
    direction: "out",
    merchant: "Corner Market",
    clean_description: "Corner Market",
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
    created_at: now,
    updated_at: now,
    ...over,
  };
}

describe("device database", () => {
  afterEach(async () => {
    closeDb("alice");
    await deleteDb("alice");
    closeDb("bob");
    await deleteDb("bob");
  });

  it("is one database per user, seeded once with the spec's categories and a cash account", async () => {
    const db = openDb("alice");
    expect(db.name).toBe("stackd-alice");
    await seedDefaults(db);
    await seedDefaults(db); // idempotent
    const categories = await db.categories.orderBy("[kind+sort]").toArray();
    expect(categories).toHaveLength(DEFAULT_CATEGORIES.length);
    expect(categories.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual([
      "Rent",
      "Groceries",
      "Utilities & phone",
      "Transport",
      "Insurance",
      "Dining",
      "Shopping",
      "Subscriptions",
      "Fun",
      "Savings",
      "Debt payoff",
      "Other",
    ]);
    expect(categories.filter((c) => c.kind === "income").map((c) => c.name)).toEqual([
      "Paycheck",
      "Side income",
      "Refund",
      "Other",
    ]);
    expect(categories.filter((c) => c.kind === "income").every((c) => c.bucket === null)).toBe(
      true,
    );
    expect(await db.accounts.get(DEFAULT_ACCOUNT.id)).toMatchObject({
      label: "Cash",
      type: "cash",
    });
    expect(openDb("alice")).toBe(db);
    expect(openDb("bob").name).toBe("stackd-bob");
    expect(await openDb("bob").categories.count()).toBe(0);
  });

  it("stores entries in cents and lists a month newest first", async () => {
    const db = openDb("alice");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry({
        date: "2026-10-01",
        merchant: "Rent",
        amount_cents: 165000,
        created_at: "2026-10-01T00:00:00Z",
      }),
      entry({ date: "2026-10-09", merchant: "Corner Market", created_at: "2026-10-09T10:00:00Z" }),
      entry({
        date: "2026-10-09",
        merchant: "Bus pass",
        amount_cents: 275,
        created_at: "2026-10-09T11:00:00Z",
      }),
      entry({ date: "2026-09-30", merchant: "September", created_at: "2026-09-30T00:00:00Z" }),
      entry({ date: "2026-11-01", merchant: "November", created_at: "2026-11-01T00:00:00Z" }),
    ]);
    const october = await entriesBetween(db, "2026-10-01", "2026-10-31");
    expect(october.map((e) => e.merchant)).toEqual(["Bus pass", "Corner Market", "Rent"]);
    expect(october.every((e) => Number.isInteger(e.amount_cents))).toBe(true);
  });

  it("refuses a duplicate import fingerprint within an account, and ignores missing ones", async () => {
    const db = openDb("alice");
    await db.entries.add(entry({ fingerprint: "fp-1", source: "import", account_id: "acct-a" }));
    await db.entries.add(entry({ fingerprint: "fp-1", source: "import", account_id: "acct-b" }));
    await expect(
      db.entries.add(entry({ fingerprint: "fp-1", source: "import", account_id: "acct-a" })),
    ).rejects.toThrow();
    await db.entries.add(entry({}));
    await db.entries.add(entry({}));
    expect(await db.entries.count()).toBe(4);
  });

  it("deleteDb removes everything for that user", async () => {
    const db = openDb("alice");
    await db.entries.add(entry({}));
    await deleteDb("alice");
    expect(await openDb("alice").entries.count()).toBe(0);
  });
});
