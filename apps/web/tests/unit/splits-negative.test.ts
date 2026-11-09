// Split bills under attack and under load (November 9, 2026): what a member who rewrites their
// own blob, a broken bill, a repeat years old or a full ledger does to everyone's view. Every
// device runs the same merge, so one bad ledger must never change or break the group (77).

import { describe, expect, it } from "vitest";
import { encryptJson, randomBytes, toBase64url } from "../../src/data/backup/crypto.ts";
import { emptyLedger, type LedgerBlob, type SplitBill } from "../../src/features/splits/ledger.ts";
import { blobAad, computeView } from "../../src/features/splits/splitSync.ts";

const YOU = "m-you"; // the organizer
const SAM = "m-sam";
const ALEX = "m-alex";
const PEOPLE = [YOU, SAM, ALEX];

function bill(over: Partial<SplitBill> & { id: string; added_by: string }): SplitBill {
  return {
    date: "2026-11-06",
    what: "Groceries",
    amount_cents: 3000,
    paid_by: over.added_by,
    people: PEOPLE,
    method: "equal",
    values: null,
    leftover_to: over.added_by,
    parts: PEOPLE.map((person) => ({ person, cents: 1000 })),
    repeat: null,
    repeat_until: null,
    updated_at: "2026-11-06T10:00:00Z",
    ...over,
  };
}

const ledger = (over: Partial<LedgerBlob>): LedgerBlob => ({ ...emptyLedger(), ...over });

async function view(ledgers: Map<string, LedgerBlob>, billIds: string[]) {
  return computeView(
    "g1",
    YOU,
    PEOPLE,
    ledgers,
    { bill_ids: billIds, pending: [], disputes: [], writable: true },
    new Map(),
    "2026-11-09",
  );
}

const cents = (v: Awaited<ReturnType<typeof view>>, who: string) =>
  v.balances.find((b) => b.person === who)?.cents ?? 0;

describe("tampering: a member rewrites their own ledger", () => {
  it("an approved bill keeps the amount the organizer approved, whatever its author writes later", async () => {
    const approved = bill({
      id: "b1",
      added_by: SAM,
      amount_cents: 2400,
      parts: PEOPLE.map((person) => ({ person, cents: 800 })),
    });
    // The organizer's device pins what it approved; Sam then rewrites the bill to $2,400
    const ledgers = new Map([
      [YOU, ledger({ approved: { b1: approved } })],
      [
        SAM,
        ledger({
          bills: [
            {
              ...approved,
              amount_cents: 240000,
              parts: PEOPLE.map((person) => ({ person, cents: 80000 })),
            },
          ],
        }),
      ],
    ]);
    const v = await view(ledgers, ["b1"]);
    expect(v.merged.bills[0]?.amount_cents).toBe(2400);
    expect(cents(v, SAM)).toBe(1600);
  });

  it("drops a bill whose parts don't add up, are negative, or aren't whole cents", async () => {
    const ledgers = new Map([
      [
        SAM,
        ledger({
          bills: [
            bill({
              id: "short",
              added_by: SAM,
              amount_cents: 3000,
              parts: PEOPLE.map((person) => ({ person, cents: 900 })),
            }),
            bill({
              id: "negative",
              added_by: SAM,
              parts: [
                { person: YOU, cents: 4000 },
                { person: SAM, cents: -1000 },
                { person: ALEX, cents: 0 },
              ],
            }),
            bill({ id: "fraction", added_by: SAM, amount_cents: 3000.5 }),
            bill({ id: "ok", added_by: SAM }),
          ],
        }),
      ],
    ]);
    const v = await view(ledgers, ["short", "negative", "fraction", "ok"]);
    expect(v.merged.bills.map((b) => b.id)).toEqual(["ok"]);
    expect(cents(v, SAM)).toBe(2000);
  });

  it("a bill too big to be real is left out rather than breaking everyone's balances", async () => {
    const huge = 2 ** 53 - 1;
    const ledgers = new Map([
      [
        SAM,
        ledger({
          bills: [
            bill({
              id: "huge",
              added_by: SAM,
              amount_cents: huge,
              parts: [
                { person: YOU, cents: huge },
                { person: SAM, cents: 0 },
                { person: ALEX, cents: 0 },
              ],
            }),
            bill({ id: "ok", added_by: SAM }),
          ],
        }),
      ],
    ]);
    const v = await view(ledgers, ["huge", "ok"]);
    expect(v.merged.bills.map((b) => b.id)).toEqual(["ok"]);
  });

  it("ignores a settlement recorded between two other people", async () => {
    const ledgers = new Map([
      [YOU, ledger({ bills: [bill({ id: "b1", added_by: YOU })] })],
      [
        ALEX,
        ledger({
          settlements: [
            {
              id: "s",
              from: SAM,
              to: YOU,
              cents: 2000,
              date: "2026-11-07",
              via: "venmo",
              confirms: null,
              at: "x",
            },
          ],
        }),
      ],
    ]);
    const v = await view(ledgers, ["b1"]);
    expect(cents(v, SAM)).toBe(-1000);
  });

  it("a ledger of the wrong shape is skipped, not fatal", async () => {
    const odd = {
      v: 1,
      bills: [{ id: "b1" }, null, "x"],
      settlements: [null],
      edits: null,
      group: 7,
    } as unknown as LedgerBlob;
    const v = await view(
      new Map([
        [SAM, odd],
        [YOU, ledger({ bills: [bill({ id: "b2", added_by: YOU })] })],
      ]),
      ["b1", "b2"],
    );
    expect(v.merged.bills.map((b) => b.id)).toEqual(["b2"]);
  });
});

describe("one bad bill never bricks the group", () => {
  it("a weekly bill dated years back stops at the most the rule allows instead of failing", async () => {
    const old = bill({ id: "r1", added_by: YOU, date: "2010-01-01", repeat: "weekly" });
    const v = await view(
      new Map([[YOU, ledger({ bills: [old, bill({ id: "b2", added_by: YOU })] })]]),
      ["r1", "b2"],
    );
    expect(v.merged.bills.some((b) => b.id === "b2")).toBe(true);
    expect(v.merged.bills.filter((b) => b.base_id === "r1").length).toBeLessThanOrEqual(400);
  });
});

describe("scale: what one ledger can hold", () => {
  it("measures how many 12-person bills fit in the 256 KB ledger", async () => {
    const twelve = Array.from({ length: 12 }, () => crypto.randomUUID());
    const one = bill({
      id: crypto.randomUUID(),
      added_by: twelve[0] as string,
      what: "x".repeat(60),
      people: twelve,
      parts: twelve.map((person) => ({ person, cents: 123456 })),
    });
    const key = randomBytes(32);
    const fits = (n: number) => ({ ...emptyLedger(), bills: Array.from({ length: n }, () => one) });
    const size = async (n: number) =>
      toBase64url(await encryptJson(key, fits(n), blobAad("g", "ledger", "m"))).length;
    let n = 1;
    while ((await size(n * 2)) <= (256 * 1024 * 4) / 3) n *= 2;
    // Recorded for the scale finding: bills one member can keep at 12 people a bill
    console.info(`12-person bills per 256 KB ledger: between ${n} and ${n * 2}`);
    expect(n).toBeGreaterThan(0);
  });
});
