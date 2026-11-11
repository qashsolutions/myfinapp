// Split bills S.7 (November 10, 2026): undo a payment, notes on payments and disputes, and the
// group's History, built on the device from the ledgers.

import { describe, expect, it } from "vitest";
import {
  canUndo,
  decodePage,
  emptyLedger,
  encodePage,
  groupHistory,
  type LedgerBlob,
  merge,
  NOTE_MAX,
  type SplitBill,
  type SplitSettlement,
} from "../../src/features/splits/ledger.ts";

const JORDAN = "m-jordan";
const SAM = "m-sam";

const bill = (id: string, by: string, amount: number, at: string): SplitBill => ({
  id,
  date: at.slice(0, 10),
  what: `bill ${id}`,
  amount_cents: amount,
  paid_by: by,
  people: [JORDAN, SAM],
  method: "equal",
  values: null,
  leftover_to: by,
  parts: [
    { person: JORDAN, cents: amount / 2 },
    { person: SAM, cents: amount / 2 },
  ],
  repeat: null,
  repeat_until: null,
  added_by: by,
  updated_at: at,
});

const pay = (id: string, over: Partial<SplitSettlement> = {}): SplitSettlement => ({
  id,
  from: SAM,
  to: JORDAN,
  cents: 1000,
  date: "2026-11-08",
  via: "venmo",
  confirms: null,
  at: "2026-11-08T10:00:00Z",
  ...over,
});

const ledger = (over: Partial<LedgerBlob>): LedgerBlob => ({ ...emptyLedger(), ...over });
const mergeOf = (ledgers: Map<string, LedgerBlob>) =>
  merge({
    organizer: JORDAN,
    ledgers,
    approved: new Set(["b1"]),
    pending: new Set(),
    disputed: new Set(["b1"]),
    repeatDates: () => [],
  });

describe("notes and undo travel on a page every build can read (S.7)", () => {
  it("keeps a payment's note and undo, and a dispute's note, with settlements still 8 fields", () => {
    const page = {
      bills: [],
      edits: {},
      approved: {},
      settlements: [
        pay("s1", { note: "Venmo, for firewood" }),
        pay("s2", { undone_at: "2026-11-09T00:00:00Z" }),
      ],
      dispute_notes: { b1: "I wasn't there that night" },
    };
    const packed = encodePage(page);
    for (const row of packed.s) expect(row).toHaveLength(8);
    const back = decodePage(JSON.parse(JSON.stringify(packed)), JORDAN);
    expect(back?.settlements.find((x) => x.id === "s1")?.note).toBe("Venmo, for firewood");
    expect(back?.settlements.find((x) => x.id === "s2")?.undone_at).toBe("2026-11-09T00:00:00Z");
    expect(back?.dispute_notes).toEqual({ b1: "I wasn't there that night" });
  });
});

describe("undoing a payment (S.7)", () => {
  it("moves nobody once undone, and lists it as undone", () => {
    const merged = mergeOf(
      new Map([
        [
          JORDAN,
          ledger({
            bills: [bill("b1", JORDAN, 4000, "2026-11-07T10:00:00Z")],
            settlements: [pay("s1", { undone_at: "2026-11-09T00:00:00Z" }), pay("s2")],
          }),
        ],
      ]),
    );
    expect(merged.settlements.map((s) => s.id)).toEqual(["s2"]);
    expect(merged.undone.map((s) => s.id)).toEqual(["s1"]);
  });

  it("is for whoever recorded it, within 7 days", () => {
    const s = pay("s1");
    expect(canUndo(s, JORDAN, JORDAN, new Date("2026-11-15T09:59:00Z"))).toBe(true);
    expect(canUndo(s, JORDAN, JORDAN, new Date("2026-11-15T10:01:00Z"))).toBe(false);
    expect(canUndo(s, JORDAN, SAM, new Date("2026-11-09T00:00:00Z"))).toBe(false);
    expect(
      canUndo({ ...s, undone_at: "x" }, JORDAN, JORDAN, new Date("2026-11-09T00:00:00Z")),
    ).toBe(false);
  });

  it("a note is at most 120 characters", () => {
    expect(NOTE_MAX).toBe(120);
  });
});

describe("the group's History (S.7)", () => {
  it("lists bills, disputes with their notes and payments, newest first", () => {
    const merged = mergeOf(
      new Map([
        [
          JORDAN,
          ledger({
            bills: [bill("b1", JORDAN, 4000, "2026-11-07T10:00:00Z")],
            settlements: [
              pay("s1", { note: "for firewood", at: "2026-11-08T10:00:00Z" }),
              pay("s2", { at: "2026-11-08T11:00:00Z", undone_at: "2026-11-08T12:00:00Z" }),
            ],
          }),
        ],
        [SAM, ledger({ dispute_notes: { b1: "I wasn't there" } })],
      ]),
    );
    const name = (id: string) => (id === JORDAN ? "Jordan" : "Sam");
    const disputes = [{ bill_id: "b1", member_id: SAM }];
    expect(groupHistory(merged, JORDAN, name, disputes).map((h) => h.text)).toEqual([
      "Sam paid Jordan $10.00 · undone",
      "Sam paid Jordan $10.00 · for firewood",
      "Added bill b1, $40.00, by Jordan",
      "Sam disputed bill b1: I wasn't there",
    ]);
  });
});
