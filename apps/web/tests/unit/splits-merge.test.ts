// Split bills: every device merges a group's ledgers the same way (invariant 77), and nothing
// leaves readable (invariant 78). Pure merge cases, the key handover round trip, and the
// canvas's Apartment 4B example through the real engine.

import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson, randomBytes } from "../../src/data/backup/crypto.ts";
import { splitShare } from "../../src/engine/bridge.ts";
import {
  emptyLedger,
  type LedgerBlob,
  merge,
  type SplitBill,
  type SplitSettlement,
} from "../../src/features/splits/ledger.ts";
import {
  blobAad,
  computeView,
  unwrapOnDevice,
  wrapForDevice,
} from "../../src/features/splits/splitSync.ts";

const YOU = "m-you";
const SAM = "m-sam";
const ALEX = "m-alex";

function bill(id: string, by: string, amount: number, paidBy: string, parts: number[]): SplitBill {
  return {
    id,
    date: "2026-11-06",
    what: `bill ${id}`,
    amount_cents: amount,
    paid_by: paidBy,
    people: [YOU, SAM, ALEX],
    method: "equal",
    values: null,
    leftover_to: paidBy,
    parts: [YOU, SAM, ALEX].map((person, i) => ({ person, cents: parts[i] ?? 0 })),
    repeat: null,
    repeat_until: null,
    added_by: by,
    updated_at: "2026-11-06T10:00:00Z",
  };
}

function ledger(over: Partial<LedgerBlob>): LedgerBlob {
  return { ...emptyLedger(), ...over };
}

function settle(
  id: string,
  from: string,
  to: string,
  cents: number,
  confirms: string | null = null,
) {
  return {
    id,
    from,
    to,
    cents,
    date: "2026-11-07",
    via: "venmo",
    confirms,
    at: "2026-11-07T10:00:00Z",
  } satisfies SplitSettlement;
}

const none = { pending: new Set<string>(), disputed: new Set<string>() };

describe("merging a group's ledgers (invariant 77)", () => {
  it("counts a bill only when its id was issued and approved; a pending one moves nobody", () => {
    const merged = merge({
      organizer: YOU,
      ledgers: new Map([
        [YOU, ledger({ bills: [bill("b1", YOU, 18600, YOU, [6200, 6200, 6200])] })],
        [
          SAM,
          ledger({
            bills: [
              bill("b2", SAM, 2400, SAM, [800, 800, 800]),
              bill("fake", SAM, 99900, SAM, [0, 0, 99900]),
            ],
          }),
        ],
      ]),
      approved: new Set(["b1"]),
      pending: new Set(["b2"]),
      disputed: new Set(),
      repeatDates: (b) => [b.date],
    });
    expect(merged.bills.map((b) => [b.id, b.status])).toEqual([
      ["b1", "approved"],
      ["b2", "pending"],
    ]);
  });

  it("takes edits, deletes and the group's settings only from the organizer's own ledger", () => {
    const original = bill("b1", SAM, 2400, SAM, [800, 800, 800]);
    const merged = merge({
      organizer: YOU,
      ledgers: new Map([
        [
          YOU,
          ledger({
            edits: {
              b1: {
                ...original,
                amount_cents: 2000,
                parts: [
                  { person: YOU, cents: 1000 },
                  { person: SAM, cents: 1000 },
                ],
              },
              b9: null,
            },
            group: {
              name: "Apartment 4B",
              kind: "home",
              usual_method: "equal",
              leftover: "payer",
              updated_at: "x",
            },
          }),
        ],
        [
          SAM,
          ledger({
            bills: [original],
            edits: { b1: null }, // a guest can't delete
            group: {
              name: "Hijacked",
              kind: "trip",
              usual_method: "exact",
              leftover: SAM,
              updated_at: "y",
            },
          }),
        ],
        // A copy of Sam's bill in Alex's ledger is not Alex's to add
        [ALEX, ledger({ bills: [{ ...original, amount_cents: 100000 }] })],
      ]),
      approved: new Set(["b1"]),
      ...none,
      repeatDates: (b) => [b.date],
    });
    expect(merged.group?.name).toBe("Apartment 4B");
    expect(merged.bills).toHaveLength(1);
    expect(merged.bills[0]).toMatchObject({
      id: "b1",
      amount_cents: 2000,
      edited: true,
      added_by: SAM,
    });
  });

  it("counts a settlement from the person paid or the organizer; the payer's own is a claim", () => {
    const merged = merge({
      organizer: YOU,
      ledgers: new Map([
        [
          SAM,
          ledger({ settlements: [settle("s1", SAM, YOU, 7600), settle("s2", SAM, ALEX, 500)] }),
        ],
        [YOU, ledger({ settlements: [settle("s3", SAM, YOU, 7600, "s1")] })],
        // Alex recording that Sam paid Priya is nobody's word
        [ALEX, ledger({ settlements: [settle("s4", SAM, YOU, 100)] })],
      ]),
      approved: new Set(),
      ...none,
      repeatDates: (b) => [b.date],
    });
    expect(merged.settlements.map((s) => s.id)).toEqual(["s3"]);
    // s1 is confirmed by s3; s2 waits for Alex
    expect(merged.claims.map((c) => [c.id, c.claimed_by])).toEqual([["s2", SAM]]);
  });

  it("adds a repeating bill's copies through today and stops at the organizer's end date", () => {
    const rent = {
      ...bill("r1", YOU, 240000, YOU, [80000, 80000, 80000]),
      date: "2026-09-01",
      repeat: "monthly" as const,
    };
    const dates = ["2026-09-01", "2026-10-01", "2026-11-01"];
    const merged = merge({
      organizer: YOU,
      ledgers: new Map([[YOU, ledger({ bills: [rent] })]]),
      approved: new Set(["r1"]),
      ...none,
      repeatDates: () => dates,
    });
    expect(merged.bills.map((b) => b.id)).toEqual(["r1:2026-11-01", "r1:2026-10-01", "r1"]);
    const stopped = merge({
      organizer: YOU,
      ledgers: new Map([
        [YOU, ledger({ bills: [rent], edits: { r1: { ...rent, repeat_until: "2026-10-15" } } })],
      ]),
      approved: new Set(["r1"]),
      ...none,
      repeatDates: () => dates,
    });
    expect(stopped.bills.map((b) => b.id)).toEqual(["r1:2026-10-01", "r1"]);
  });
});

describe("the canvas's Apartment 4B, through the engine", () => {
  it("simplifies to Sam pays you $76 and Alex pays you $10; a dispute puts its bill on hold", async () => {
    const groceries = await splitShare(18600, "equal", [YOU, SAM, ALEX], YOU);
    const internet = await splitShare(9000, "equal", [YOU, SAM, ALEX], ALEX);
    const cleaning = await splitShare(2400, "equal", [YOU, SAM, ALEX], SAM);
    const b = (id: string, by: string, amount: number, parts: typeof groceries.parts) => ({
      ...bill(id, by, amount, by, []),
      parts,
    });
    const ledgers = new Map([
      [YOU, ledger({ bills: [b("groceries", YOU, 18600, groceries.parts)] })],
      [ALEX, ledger({ bills: [b("internet", ALEX, 9000, internet.parts)] })],
      [SAM, ledger({ bills: [b("cleaning", SAM, 2400, cleaning.parts)] })],
    ]);
    const state = {
      bill_ids: ["groceries", "internet", "cleaning"],
      pending: [],
      disputes: [],
      writable: true,
    };
    const view = await computeView(
      "g1",
      YOU,
      [YOU, SAM, ALEX],
      ledgers,
      state,
      new Map(),
      "2026-11-08",
    );
    expect(view.payments).toEqual([
      { from: SAM, to: YOU, cents: 7600 },
      { from: ALEX, to: YOU, cents: 1000 },
    ]);
    const held = await computeView(
      "g1",
      YOU,
      [YOU, SAM, ALEX],
      ledgers,
      { ...state, disputes: [{ bill_id: "cleaning", member_id: SAM }] },
      new Map(),
      "2026-11-08",
    );
    expect(held.onHold).toEqual(["cleaning"]);
    expect(held.balances.find((p) => p.person === YOU)?.cents).toBe(9400);
  });
});

describe("keys and blobs (invariant 78)", () => {
  it("hands the group key to a device's public key and nobody else", async () => {
    const groupKey = randomBytes(32);
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const wrapped = await wrapForDevice(groupKey, pub, "stackd-split-key:g1:m-sam:dev1");
    expect(await unwrapOnDevice(jwk, wrapped, "stackd-split-key:g1:m-sam:dev1")).toEqual(groupKey);
    await expect(unwrapOnDevice(jwk, wrapped, "stackd-split-key:g1:m-alex:dev1")).rejects.toThrow();
  });

  it("binds a ledger to its author: moved to another member's name, it doesn't open", async () => {
    const key = randomBytes(32);
    const sealed = await encryptJson(key, ledger({}), blobAad("g1", "ledger", SAM));
    await expect(decryptJson(key, sealed, blobAad("g1", "ledger", SAM))).resolves.toBeTruthy();
    await expect(decryptJson(key, sealed, blobAad("g1", "ledger", YOU))).rejects.toThrow();
  });
});
