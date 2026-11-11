import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/data/db.ts";
import { payAppOf, spotted } from "../../src/features/splits/spotted.ts";

const ME = "m-me";
const SAM = "m-sam";
const ALEX = "m-alex";

function row(over: Partial<Entry>): Entry {
  return {
    id: "e1",
    date: "2026-11-07",
    amount_cents: 7600,
    direction: "in",
    merchant: "VENMO CASHOUT",
    clean_description: "VENMO CASHOUT",
    raw_description: "VENMO CASHOUT SAM L",
    category_id: null,
    account_id: "a-chk",
    source: "linked",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    provider_txn_id: "p1",
    created_at: "x",
    updated_at: "x",
    ...over,
  } as Entry;
}

describe("Spotted (a linked payment that matches what's due, suggested only)", () => {
  const due = [
    { from: SAM, to: ME, cents: 7600 },
    { from: ME, to: ALEX, cents: 1250 },
  ];
  it("matches money in for a friend paying me and money out for me paying a friend", () => {
    const spots = spotted(
      due,
      ME,
      [
        row({}),
        row({
          id: "e2",
          direction: "out",
          amount_cents: 1250,
          merchant: "Cash App*Alex",
          raw_description: null,
          provider_txn_id: "p2",
        }),
      ],
      new Set(),
      "2026-11-11",
    );
    expect(spots.map((s) => [s.entry.id, s.direction, s.app, s.payment.cents])).toEqual([
      ["e1", "in", "venmo", 7600],
      ["e2", "out", "cashapp", 1250],
    ]);
  });

  it("never matches a typed or pending row, another amount, no pay app, too old, already used or turned down", () => {
    const today = "2026-11-11";
    const none = (e: Partial<Entry>, dismissed = new Set<string>()) =>
      spotted(due, ME, [row(e)], dismissed, today);
    expect(none({ provider_txn_id: undefined })).toEqual([]);
    expect(none({ pending: true })).toEqual([]);
    expect(none({ amount_cents: 7500 })).toEqual([]);
    expect(none({ merchant: "PAYROLL", raw_description: "ACME PAYROLL" })).toEqual([]);
    expect(none({ date: "2026-10-27" })).toEqual([]); // 15 days back
    expect(none({ paid_back: true })).toEqual([]);
    expect(none({ split_bill: "g:b" })).toEqual([]);
    expect(none({}, new Set(["e1"]))).toEqual([]);
    expect(none({ date: "2026-10-28" })).toHaveLength(1); // 14 days back
  });

  it("offers each bank row once, the newest first, and leaves payments between others alone", () => {
    const spots = spotted(
      [
        { from: SAM, to: ME, cents: 7600 },
        { from: ALEX, to: ME, cents: 7600 },
        { from: SAM, to: ALEX, cents: 7600 },
      ],
      ME,
      [
        row({ id: "old", date: "2026-11-05" }),
        row({ id: "new", date: "2026-11-09", provider_txn_id: "p9" }),
      ],
      new Set(),
      "2026-11-11",
    );
    expect(spots.map((s) => [s.payment.from, s.entry.id])).toEqual([
      [SAM, "new"],
      [ALEX, "old"],
    ]);
  });

  it("a row that names someone goes to that person, never to someone else", () => {
    const names = (id: string) => ({ [SAM]: "Sam L.", [ALEX]: "Alex M.", [ME]: "You" })[id] ?? "";
    const spots = spotted(
      [
        { from: SAM, to: ME, cents: 6200 },
        { from: ALEX, to: ME, cents: 6200 },
      ],
      ME,
      [
        row({
          id: "z",
          amount_cents: 6200,
          merchant: "ZELLE FROM ALEX",
          raw_description: null,
          provider_txn_id: "pz",
        }),
        row({
          id: "v",
          amount_cents: 6200,
          date: "2026-11-06",
          merchant: "VENMO CASHOUT",
          raw_description: null,
          provider_txn_id: "pv",
        }),
      ],
      new Set(),
      "2026-11-11",
      names,
      [ME, SAM, ALEX],
    );
    expect(spots.map((s) => [s.payment.from, s.entry.id])).toEqual([
      [SAM, "v"],
      [ALEX, "z"],
    ]);
    // Alex's row is never offered as Sam's when Alex owes nothing.
    expect(
      spotted(
        [{ from: SAM, to: ME, cents: 6200 }],
        ME,
        [row({ id: "z", amount_cents: 6200, merchant: "ZELLE FROM ALEX", raw_description: null })],
        new Set(),
        "2026-11-11",
        names,
        [ME, SAM, ALEX],
      ),
    ).toEqual([]);
  });

  it("reads the pay app as a whole word", () => {
    expect(payAppOf("VENMO *SAM")?.app).toBe("venmo");
    expect(payAppOf("SQC*ALEX M")?.app).toBe("cashapp");
    expect(payAppOf("Zelle payment from Sam")?.label).toBe("Zelle");
    expect(payAppOf("VENMOUTH CAFE")).toBeNull();
  });
});
