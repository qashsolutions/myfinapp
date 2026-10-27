import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { DEFAULT_CATEGORIES } from "../../src/data/defaults.ts";
import {
  checkName,
  createCategory,
  removeCategory,
  updateCategory,
} from "../../src/features/categories/categories.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function entry(id: string, category: string, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: 450,
    direction: "out",
    merchant: "Blue Bottle",
    clean_description: "BLUE BOTTLE",
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
    ...extra,
  };
}

describe("your categories (October 20, 2026)", () => {
  it("tidies names and keeps them unique within money out or money in", () => {
    expect(checkName("  Coffee   shops ", "expense", DEFAULT_CATEGORIES)).toEqual({
      name: "Coffee shops",
    });
    expect(checkName("   ", "expense", DEFAULT_CATEGORIES)).toEqual({ problem: "empty" });
    expect(checkName("x".repeat(25), "expense", DEFAULT_CATEGORIES)).toEqual({
      problem: "too_long",
    });
    expect(checkName("dining", "expense", DEFAULT_CATEGORIES)).toEqual({ problem: "taken" });
    // Renaming a category to its own name, or reusing a money-out name for money in, is fine.
    expect(checkName("Dining", "expense", DEFAULT_CATEGORIES, "cat-dining")).toEqual({
      name: "Dining",
    });
    expect(checkName("Dining", "income", DEFAULT_CATEGORIES)).toEqual({ name: "Dining" });
  });

  it("adds one from the entry editor and picks it", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("e1", "cat-dining"));
    installFakeApi({ session: readySession() });
    renderApp("/entries/e1");
    await user.click(await screen.findByRole("button", { name: "+ New" }));
    const sheet = await screen.findByRole("dialog", { name: "New category" });
    await user.type(within(sheet).getByLabelText("Name"), "Coffee");
    await user.click(within(sheet).getByLabelText("Wants"));
    await user.click(within(sheet).getByRole("button", { name: "Add category" }));
    expect(await screen.findByRole("radio", { name: "Coffee" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(async () => {
      const coffee = (await db.categories.toArray()).find((c) => c.name === "Coffee");
      expect(coffee).toMatchObject({ kind: "expense", bucket: "want", is_default: false });
      expect((await db.entries.get("e1"))?.category_id).toBe(coffee?.id);
    });
  });

  it("renames a built-in one and hides another from the pickers", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/me/categories");
    await user.click(await screen.findByRole("button", { name: /^Dining/ }));
    const sheet = await screen.findByRole("dialog", { name: "Edit Dining" });
    const name = within(sheet).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Eating out");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: /^Eating out/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Fun/ }));
    const fun = await screen.findByRole("dialog", { name: "Edit Fun" });
    await user.click(within(fun).getByRole("switch", { name: "Show when picking a category" }));
    await waitFor(async () => expect((await db.categories.get("cat-fun"))?.hidden).toBe(true));
    const renamed = await db.categories.get("cat-dining");
    expect(renamed?.name).toBe("Eating out");
    expect(renamed?.updated_at).toBeTruthy();
  });

  it("joins zero-based budgets from this month on with nothing planned", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const base = { take_home_cents: 500000, created_at: "x", updated_at: "x" };
    await db.budgets.bulkAdd([
      { id: "b-sep", month: "2026-09", method: "zero_based", ...base },
      { id: "b-oct", month: "2026-10", method: "zero_based", ...base },
      { id: "b-rule", month: "2026-11", method: "50_30_20", ...base },
    ]);
    const made = await createCategory(
      db,
      { name: "Pets", kind: "expense", bucket: "need" },
      new Date(2026, 9, 20),
    );
    const lines = (await db.budget_lines.toArray()).filter((l) => l.category_id === made.id);
    expect(lines.map((l) => [l.budget_id, l.planned_cents])).toEqual([["b-oct", 0]]);
    expect(made.sort).toBeGreaterThan(120);
    await expect(
      createCategory(db, { name: "pets", kind: "expense", bucket: "need" }),
    ).rejects.toThrow("taken");
  });

  it("removes one of your own after moving its entries, rules, plan and goals", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const coffee = await createCategory(db, { name: "Coffee", kind: "expense", bucket: "want" });
    await db.entries.bulkAdd([
      entry("e1", coffee.id),
      entry("e2", coffee.id),
      entry("e3", "cat-fun"),
    ]);
    await db.merchant_rules.add({
      id: "r1",
      match: "BLUE BOTTLE",
      category_id: coffee.id,
      created_at: "x",
    });
    await db.budget_lines.bulkAdd([
      { id: "l1", budget_id: "b1", category_id: coffee.id, planned_cents: 4000 },
      { id: "l2", budget_id: "b1", category_id: "cat-dining", planned_cents: 20000 },
      { id: "l3", budget_id: "b2", category_id: coffee.id, planned_cents: 3000 },
    ]);
    await updateCategory(db, "cat-dining", { name: "Eating out" });
    await removeCategory(db, coffee.id, "cat-dining", new Date("2026-10-20T12:00:00Z"));

    expect(await db.categories.get(coffee.id)).toBeUndefined();
    expect((await db.entries.get("e1"))?.category_id).toBe("cat-dining");
    expect((await db.entries.get("e1"))?.updated_at).toBe("2026-10-20T12:00:00.000Z");
    expect((await db.entries.get("e3"))?.category_id).toBe("cat-fun");
    expect((await db.merchant_rules.get("r1"))?.category_id).toBe("cat-dining");
    expect((await db.budget_lines.get("l2"))?.planned_cents).toBe(24000);
    expect(await db.budget_lines.get("l1")).toBeUndefined();
    expect((await db.budget_lines.get("l3"))?.category_id).toBe("cat-dining");
    const tombs = (await db.tombstones.toArray()).map((t) => `${t.table}:${t.id}`).sort();
    expect(tombs).toEqual([`budget_lines:l1`, `categories:${coffee.id}`]);
    await expect(removeCategory(db, "cat-fun", "cat-dining")).rejects.toThrow("invalid");
  });
});
