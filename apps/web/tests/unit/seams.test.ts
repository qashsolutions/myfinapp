/**
 * Seams between features that each work alone (October 27, 2026; docs/invariants.md "Working to
 * these rules"): every write here applies to what is stored now, never to a screen's snapshot.
 */
import { openDb, seedDefaults } from "../../src/data/db.ts";
import {
  assignRest,
  moveBetween,
  undoAssign,
  undoMove,
} from "../../src/features/budget/zeroBased.ts";

async function lines() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.budget_lines.bulkAdd([
    { id: "l-food", budget_id: "b", category_id: "cat-groceries", planned_cents: 30000 },
    { id: "l-fun", budget_id: "b", category_id: "cat-dining", planned_cents: 10000 },
  ]);
  return db;
}

describe("zero-based writes use the stored line, not the screen's snapshot", () => {
  it("Assign what's left adds to what is stored now", async () => {
    const db = await lines();
    // The screen drew the line at $200; a blur-commit then stored $300.
    const stale = {
      id: "l-food",
      budget_id: "b",
      category_id: "cat-groceries",
      planned_cents: 20000,
    };
    await assignRest(db, stale, 10000);
    expect((await db.budget_lines.get("l-food"))?.planned_cents).toBe(40000);
  });

  it("Move checks and moves against what is stored now", async () => {
    const db = await lines();
    const staleFrom = {
      id: "l-food",
      budget_id: "b",
      category_id: "cat-groceries",
      planned_cents: 5000,
    };
    const to = { id: "l-fun", budget_id: "b", category_id: "cat-dining", planned_cents: 10000 };
    expect(await moveBetween(db, staleFrom, to, 25000)).toBeNull(); // $300 stored covers $250
    expect((await db.budget_lines.get("l-food"))?.planned_cents).toBe(5000);
    expect((await db.budget_lines.get("l-fun"))?.planned_cents).toBe(35000);
  });

  it("Undo reverses the move itself and keeps an edit made since", async () => {
    const db = await lines();
    const from = (await db.budget_lines.get("l-food"))!;
    const to = (await db.budget_lines.get("l-fun"))!;
    await moveBetween(db, from, to, 5000);
    await db.budget_lines.update("l-fun", { planned_cents: 20000 }); // typed since
    await undoMove(db, from.id, to.id, 5000);
    expect((await db.budget_lines.get("l-food"))?.planned_cents).toBe(30000);
    expect((await db.budget_lines.get("l-fun"))?.planned_cents).toBe(15000);
    await assignRest(db, from, 2500);
    await db.budget_lines.update("l-food", { planned_cents: 40000 });
    await undoAssign(db, from.id, 2500);
    expect((await db.budget_lines.get("l-food"))?.planned_cents).toBe(37500);
  });
});
