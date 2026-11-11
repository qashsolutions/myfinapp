// Split bills, round two (chunk S.6, November 10, 2026): Run this group keeps every correction,
// a guest's bill follows the usual split, and a bill's history says what changed.

import { describe, expect, it } from "vitest";
import {
  billHistory,
  emptyLedger,
  guestSplit,
  type LedgerBlob,
  merge,
  type SplitBill,
  type SplitSettlement,
  takeOverLedger,
} from "../../src/features/splits/ledger.ts";

const JORDAN = "m-jordan";
const SAM = "m-sam";
const ALEX = "m-alex";

function bill(id: string, by: string, amount: number, over: Partial<SplitBill> = {}): SplitBill {
  const half = Math.floor(amount / 2);
  return {
    id,
    date: "2026-11-06",
    what: `bill ${id}`,
    amount_cents: amount,
    paid_by: by,
    people: [by, by === SAM ? ALEX : SAM],
    method: "equal",
    values: null,
    leftover_to: by,
    parts: [
      { person: by, cents: amount - half },
      { person: by === SAM ? ALEX : SAM, cents: half },
    ],
    repeat: null,
    repeat_until: null,
    added_by: by,
    updated_at: "2026-11-06T10:00:00Z",
    ...over,
  };
}

const settle = (id: string, from: string, to: string, cents: number): SplitSettlement => ({
  id,
  from,
  to,
  cents,
  date: "2026-11-07",
  via: "venmo",
  confirms: null,
  at: "2026-11-07T10:00:00Z",
});

const ledger = (over: Partial<LedgerBlob>): LedgerBlob => ({ ...emptyLedger(), ...over });
const view = (organizer: string | null, ledgers: Map<string, LedgerBlob>) =>
  merge({
    organizer,
    ledgers,
    approved: new Set(["b1", "b2", "b3"]),
    pending: new Set(),
    disputed: new Set(),
    repeatDates: () => [],
  });

describe("Run this group (S.6)", () => {
  // Jordan ran the group: deleted b2, corrected Sam's b3, approved it, named the group, and
  // recorded Sam paying Alex. Alex takes over.
  const jordan = ledger({
    bills: [bill("b1", JORDAN, 1000)],
    edits: { b2: null, b3: bill("b3", SAM, 4500) },
    approved: { b3: bill("b3", SAM, 3000) },
    settlements: [settle("s1", SAM, ALEX, 500)],
    group: {
      name: "Lake house",
      kind: "trip",
      usual_method: "equal",
      leftover: "payer",
      updated_at: "2026-11-01T00:00:00Z",
    },
  });
  const sam = ledger({ bills: [bill("b2", SAM, 2000), bill("b3", SAM, 3000)] });
  const before = view(
    JORDAN,
    new Map([
      [JORDAN, jordan],
      [SAM, sam],
      [ALEX, ledger({})],
    ]),
  );

  it("leaves every device showing the same group, its name, deletions, corrections and payments", () => {
    const alex = takeOverLedger(ledger({}), jordan, JORDAN);
    const after = view(
      ALEX,
      new Map([
        [JORDAN, jordan],
        [SAM, sam],
        [ALEX, alex],
      ]),
    );
    expect(after.group?.name).toBe("Lake house");
    expect(after.bills.map((b) => [b.id, b.amount_cents])).toEqual(
      before.bills.map((b) => [b.id, b.amount_cents]),
    );
    expect(after.bills.find((b) => b.id === "b2")).toBeUndefined();
    expect(after.settlements.map((s) => s.id)).toEqual(["s1"]);
    // Jordan's own copy of s1 no longer counts as the organizer's; it is not a claim either.
    expect(after.claims).toEqual([]);
  });

  it("keeps what the new organizer had already decided over the old one's", () => {
    const mine = ledger({ edits: { b3: bill("b3", SAM, 5000) } });
    const alex = takeOverLedger(mine, jordan, JORDAN);
    expect(alex.edits.b3?.amount_cents).toBe(5000);
    expect(Object.hasOwn(alex.edits, "b2")).toBe(true);
  });
});

describe("a bill's history (S.6)", () => {
  it("says who added it, when it was approved, and each field the organizer changed", () => {
    const approved = { ...bill("b3", SAM, 3000), updated_at: "2026-11-07T09:00:00Z" };
    const edited = {
      ...bill("b3", SAM, 4500),
      what: "Groceries",
      updated_at: "2026-11-08T12:00:00Z",
    };
    const merged = merge({
      organizer: JORDAN,
      ledgers: new Map([
        [JORDAN, ledger({ edits: { b3: edited }, approved: { b3: approved } })],
        [SAM, ledger({ bills: [bill("b3", SAM, 3000)] })],
      ]),
      approved: new Set(["b3"]),
      pending: new Set(),
      disputed: new Set(),
      repeatDates: () => [],
    });
    const shown = merged.bills[0];
    if (!shown) throw new Error("no bill");
    const name = (id: string) => ({ [JORDAN]: "Jordan", [SAM]: "Sam", [ALEX]: "Alex" })[id] ?? id;
    expect(billHistory(shown, JORDAN, name)).toEqual([
      { at: "2026-11-06T10:00:00Z", text: "Added by Sam" },
      { at: "2026-11-07T09:00:00Z", text: "Approved by Jordan" },
      {
        at: "2026-11-08T12:00:00Z",
        text: "Changed by Jordan: amount $30.00 → $45.00 · what bill b3 → Groceries",
      },
    ]);
  });
});

describe("a guest's bill follows the usual split (S.6)", () => {
  const meta = (usual_method: SplitBill["method"], usual_values?: Record<string, number>) => ({
    name: "g",
    kind: "home",
    usual_method,
    usual_values: usual_values ?? null,
    leftover: "payer" as const,
    updated_at: "x",
  });
  const live = [JORDAN, SAM, ALEX];
  it("uses the organizer's shares when everyone in it has one", () => {
    expect(guestSplit(meta("shares", { [JORDAN]: 2, [SAM]: 1, [ALEX]: 1 }), live)).toEqual({
      method: "shares",
      values: { [JORDAN]: 2, [SAM]: 1, [ALEX]: 1 },
    });
  });
  it("splits equally when someone has no value, the usual is Exact, or there is no setting", () => {
    expect(guestSplit(meta("shares", { [JORDAN]: 2, [SAM]: 1 }), live)).toEqual({
      method: "equal",
      values: null,
    });
    expect(guestSplit(meta("exact"), live)).toEqual({ method: "equal", values: null });
    expect(guestSplit(null, live)).toEqual({ method: "equal", values: null });
  });
  it("uses percents only when they add up to 100", () => {
    const pct = { [JORDAN]: 5000, [SAM]: 2500, [ALEX]: 2500 };
    expect(guestSplit(meta("percent", pct), live).method).toBe("percent");
    expect(guestSplit(meta("percent", { ...pct, [ALEX]: 2000 }), live).method).toBe("equal");
  });
});
