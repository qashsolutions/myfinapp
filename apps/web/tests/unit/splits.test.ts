import type { Entry } from "../../src/data/db.ts";
import { bankRows, splitTree } from "../../src/features/entries/splits.ts";

function row(id: string, cents: number, parent: string | null = null): Entry {
  return {
    id,
    date: "2026-10-18",
    amount_cents: cents,
    direction: "out",
    merchant: "NETFLIX",
    clean_description: "NETFLIX",
    raw_description: null,
    category_id: null,
    account_id: "a",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: parent,
    is_recurring: false,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
}

describe("split parts (docs/invariants.md rule 1)", () => {
  const rows = [row("p", 7000), row("c", 2000, "p"), row("g", 1000, "c"), row("other", 500)];

  it("finds every part under an entry, a part's parts too", () => {
    expect(
      splitTree(rows)(["p"])
        .map((e) => e.id)
        .sort(),
    ).toEqual(["c", "g"]);
    expect(splitTree(rows)(["other"])).toEqual([]);
  });

  it("gives back the bank's rows: each entry at its amount plus all its parts", () => {
    expect(bankRows(rows).map((e) => [e.id, e.amount_cents])).toEqual([
      ["p", 10000],
      ["other", 500],
    ]);
  });
});
