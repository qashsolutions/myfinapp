// Split bills at scale (chunk S.5, November 9, 2026): a member's ledger in monthly pages, written
// compactly, put back together the same on every device; a change touches only its own page; and
// opening a group again downloads only what changed.

import { beforeEach, describe, expect, it } from "vitest";
import { encryptJson, randomBytes, toBase64url } from "../../src/data/backup/crypto.ts";
import { openDb } from "../../src/data/db.ts";
import {
  canonical,
  combinePages,
  decodePage,
  emptyPage,
  encodePage,
  type LedgerBlob,
  type LedgerPage,
  merge,
  placeOnPages,
  type SplitBill,
  type SplitSettlement,
} from "../../src/features/splits/ledger.ts";
import { blobAad, groupKey, pullGroup } from "../../src/features/splits/splitSync.ts";
import { addBill, createSplitGroup } from "../../src/features/splits/useSplits.ts";
import { todayIso } from "../../src/lib/format.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";

const YOU = "8d0f4c1e-1111-4a5b-9c3d-000000000001";
const SAM = "8d0f4c1e-2222-4a5b-9c3d-000000000002";
const ALEX = "8d0f4c1e-3333-4a5b-9c3d-000000000003";

function bill(over: Partial<SplitBill> & { id: string }): SplitBill {
  return {
    date: "2026-10-06",
    what: "Groceries",
    amount_cents: 3000,
    paid_by: YOU,
    people: [YOU, SAM, ALEX],
    method: "equal",
    values: null,
    leftover_to: YOU,
    parts: [YOU, SAM, ALEX].map((person) => ({ person, cents: 1000 })),
    repeat: null,
    repeat_until: null,
    added_by: YOU,
    updated_at: "2026-10-06T10:00:00Z",
    ...over,
  };
}

const paid: SplitSettlement = {
  id: "s1",
  from: SAM,
  to: YOU,
  cents: 1000,
  date: "2026-10-08",
  via: "venmo",
  confirms: null,
  at: "2026-10-08T09:00:00Z",
};

describe("a page written compactly", () => {
  it("reads back exactly: exact amounts, repeats, edits, deletes, approvals and payments", () => {
    const exact = bill({
      id: "b2",
      method: "exact",
      amount_cents: 2500,
      values: { [YOU]: 500, [SAM]: 2000 },
      people: [YOU, SAM],
      parts: [
        { person: YOU, cents: 500 },
        { person: SAM, cents: 2000 },
      ],
      repeat: "monthly",
      repeat_until: "2027-01-31",
    });
    const page: LedgerPage = {
      bills: [bill({ id: "b1" }), exact],
      edits: { b1: bill({ id: "b1", what: "Fixed" }), b9: null },
      approved: { b7: bill({ id: "b7", added_by: SAM, paid_by: SAM }) },
      settlements: [paid],
    };
    const back = decodePage(JSON.parse(JSON.stringify(encodePage(page))), YOU);
    // A pinned or edited copy reads as the author's; merge puts back each bill's real author.
    const asRead = { ...page, approved: { b7: { ...page.approved.b7, added_by: YOU } } };
    expect(canonical(back)).toBe(canonical(asRead));
  });

  it("fits a month at the most bills a day, 12 people a bill, in one 256 KB page", async () => {
    // 12 a day for 31 days, each the longest name and twelve people (the old single ledger held
    // about 160 of these in all, so a busy group filled it in 13 days).
    const twelve = Array.from({ length: 12 }, () => crypto.randomUUID());
    const one = (i: number) =>
      bill({
        id: crypto.randomUUID(),
        what: "x".repeat(60),
        paid_by: twelve[i % 12] as string,
        leftover_to: twelve[0] as string,
        people: twelve,
        amount_cents: 12 * 123456,
        parts: twelve.map((person) => ({ person, cents: 123456 })),
        updated_at: new Date().toISOString(),
      });
    const page = { ...emptyPage(), bills: Array.from({ length: 12 * 31 }, (_, i) => one(i)) };
    const key = randomBytes(32);
    const sealed = toBase64url(
      await encryptJson(key, encodePage(page), blobAad("g", "ledger:2026-11", "m")),
    );
    const bytes = (sealed.length * 3) / 4;
    console.info(`a month at 12 a day, 12 people a bill: ${Math.round(bytes / 1024)} KB`);
    expect(bytes).toBeLessThan(256 * 1024);
  });

  it("never throws on a broken page: bad indexes make bills every device leaves out", () => {
    const packed = encodePage({ ...emptyPage(), bills: [bill({ id: "b1" })] });
    const broken = { ...packed, b: [[...(packed.b[0] ?? [])].map((x, i) => (i === 4 ? 99 : x))] };
    const page = decodePage(broken, YOU);
    expect(page?.bills).toHaveLength(1);
    const merged = merge({
      organizer: YOU,
      ledgers: new Map([[YOU, combinePages(null, new Map([["2026-10", page ?? emptyPage()]]))]]),
      approved: new Set(["b1"]),
      pending: new Set(),
      disputed: new Set(),
      repeatDates: (b) => [b.date],
    });
    expect(merged.bills).toEqual([]);
    for (const junk of [null, 7, "x", { v: 1 }, { v: 2 }, { v: 2, p: [], b: [[1, 2]] }])
      expect(() => decodePage(junk, YOU)).not.toThrow();
    expect(decodePage({ v: 1, p: [] }, YOU)).toBeNull();
  });
});

describe("a change goes on its own page", () => {
  const october: LedgerPage = {
    ...emptyPage(),
    bills: [bill({ id: "b1" }), bill({ id: "b2" })],
    edits: { b5: bill({ id: "b5", what: "Old fix" }) },
    approved: { b7: bill({ id: "b7", added_by: SAM }) },
    settlements: [paid],
  };
  const before = new Map([["2026-10", october]]);
  const was = combinePages(null, before);

  it("a new bill and a new payment go on this month's page; October is untouched", () => {
    const next: LedgerBlob = {
      ...was,
      bills: [...was.bills, bill({ id: "b3", date: "2026-11-02" })],
      settlements: [...was.settlements, { ...paid, id: "s2" }],
    };
    const out = placeOnPages(before, next, "2026-11");
    expect(canonical(out.get("2026-10"))).toBe(canonical(october));
    expect(out.get("2026-11")?.bills.map((b) => b.id)).toEqual(["b3"]);
    expect(out.get("2026-11")?.settlements.map((s) => s.id)).toEqual(["s2"]);
  });

  it("an old bill changed or removed stays on (or leaves) its own page", () => {
    const next: LedgerBlob = {
      ...was,
      bills: [bill({ id: "b1", what: "Changed" })],
    };
    const out = placeOnPages(before, next, "2026-11");
    expect(out.get("2026-10")?.bills.map((b) => `${b.id}:${b.what}`)).toEqual(["b1:Changed"]);
    expect(out.get("2026-11")?.bills).toEqual([]);
  });

  it("a later edit is written on the newest page and wins; a withdrawn approval leaves every page", () => {
    const next: LedgerBlob = {
      ...was,
      edits: { b5: bill({ id: "b5", what: "New fix" }) },
      approved: {},
    };
    const out = placeOnPages(before, next, "2026-11");
    expect(out.get("2026-10")?.edits.b5?.what).toBe("Old fix");
    expect(out.get("2026-11")?.edits.b5?.what).toBe("New fix");
    expect(out.get("2026-10")?.approved).toEqual({});
    expect(combinePages(null, out).edits.b5?.what).toBe("New fix");
  });

  it("a bill written twice (a retry after a partial write) is kept once", () => {
    const next: LedgerBlob = { ...was, bills: [...was.bills, bill({ id: "b1" })] };
    const out = placeOnPages(before, next, "2026-11");
    expect(combinePages(null, out).bills.map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("puts the same pages back together whatever order they arrive in", () => {
    const nov = { ...emptyPage(), bills: [bill({ id: "b1", what: "Later copy" })] };
    const a = combinePages(
      null,
      new Map([
        ["2026-10", october],
        ["2026-11", nov],
      ]),
    );
    const b = combinePages(
      null,
      new Map([
        ["2026-11", nov],
        ["2026-10", october],
      ]),
    );
    expect(canonical(a)).toBe(canonical(b));
    expect(a.bills.find((x) => x.id === "b1")?.what).toBe("Later copy");
  });
});

describe("on the device", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = installFakeApi({ session: readySession() });
  });

  async function group() {
    const db = openDb("u1");
    const r = await createSplitGroup(db, {
      name: "Apartment 4B",
      kind: "home",
      usual_method: "equal",
      leftover: "payer",
    });
    if (!r.ok) throw new Error(r.code);
    const g = api.splits.groups[0];
    if (!g) throw new Error("no group");
    return { db, g };
  }

  it("adding a bill writes this month's page only, never the group's head again", async () => {
    const { db, g } = await group();
    const me = g.members[0]?.member_id as string;
    const head = g.blobs.find((b) => b.kind === "ledger")?.version;
    const r = await addBill(
      db,
      { id: g.id, my_member_id: me } as never,
      {
        date: todayIso(),
        what: "Groceries",
        amount_cents: 3000,
        paid_by: me,
        people: [me],
        method: "equal",
        values: null,
        leftover_to: me,
        parts: [{ person: me, cents: 3000 }],
        repeat: null,
      } as never,
    );
    expect(r.ok).toBe(true);
    expect(g.blobs.find((b) => b.kind === "ledger")?.version).toBe(head);
    expect(g.blobs.map((b) => b.kind).sort()).toEqual([
      "ledger",
      `ledger:${todayIso().slice(0, 7)}`,
    ]);
  });

  it("opening a group again downloads only what changed, and nothing when nothing did", async () => {
    const { db, g } = await group();
    const me = g.members[0]?.member_id as string;
    const open = () => pullGroup(db, g.id, { memberId: me, organizer: me, live: [me] }, todayIso());
    expect((await open())?.merged.group?.name).toBe("Apartment 4B");
    const calls = () => api.calls.filter((c) => c.path === `/api/splits/${g.id}/state`);
    const before = calls().length;
    await open();
    const again = calls().slice(before);
    expect(again.length).toBeGreaterThan(0);
    // The device named the version it holds, and the server sent no blob back.
    expect(api.splits.stateReads.at(-1)?.known).toBe(1);
    expect((await open())?.merged.group?.name).toBe("Apartment 4B");
    expect(await db.split_blobs.count()).toBe(1);
    expect(await groupKey(db, g.id)).not.toBeNull();
  });
});
