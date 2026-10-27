/**
 * Your categories (docs/spec.md "Budgeting", October 20, 2026): add your own, rename any, move
 * any to another part of the budget, hide a built-in one, remove your own after moving what used
 * it. Names are tidied here; no money math, so nothing goes through the engine.
 */

import { recordDeletion } from "../../data/backup/snapshot.ts";
import type { Bucket, Category, StackdDb } from "../../data/db.ts";

export const NAME_MAX = 24;
/** Proposed: enough for anyone's own list, few enough that the pickers stay usable. */
export const MAX_OWN = 40;

export type CategoryKind = Category["kind"];

export type NameProblem = "empty" | "too_long" | "taken";

/** Trims, folds runs of spaces, and checks the 1–24 characters and uniqueness within its kind. */
export function checkName(
  raw: string,
  kind: CategoryKind,
  existing: Category[],
  self?: string,
): { name: string } | { problem: NameProblem } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { problem: "empty" };
  if ([...name].length > NAME_MAX) return { problem: "too_long" };
  const lower = name.toLowerCase();
  if (existing.some((c) => c.kind === kind && c.id !== self && c.name.toLowerCase() === lower))
    return { problem: "taken" };
  return { name };
}

export const NAME_PROBLEM: Record<NameProblem, string> = {
  empty: "Give it a name.",
  too_long: `Keep it to ${NAME_MAX} characters.`,
  taken: "You already have a category with that name.",
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  need: "Needs",
  want: "Wants",
  save: "Save + pay down",
};

function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Adds one of the person's own categories, last in its kind; joins zero-based budgets from this month. */
export async function createCategory(
  db: StackdDb,
  input: { name: string; kind: CategoryKind; bucket: Bucket | null },
  now: Date = new Date(),
): Promise<Category> {
  const all = await db.categories.toArray();
  const checked = checkName(input.name, input.kind, all);
  if ("problem" in checked) throw new Error(checked.problem);
  if (all.filter((c) => !c.is_default).length >= MAX_OWN) throw new Error("too_many");
  const sort = Math.max(0, ...all.filter((c) => c.kind === input.kind).map((c) => c.sort)) + 10;
  const category: Category = {
    id: crypto.randomUUID(),
    name: checked.name,
    kind: input.kind,
    bucket: input.kind === "expense" ? (input.bucket ?? "want") : null,
    is_default: false,
    sort,
    updated_at: now.toISOString(),
  };
  await db.transaction("rw", db.categories, db.budgets, db.budget_lines, async () => {
    await db.categories.add(category);
    if (category.kind !== "expense") return;
    const month = currentMonth(now);
    const budgets = (await db.budgets.toArray()).filter(
      (b) => b.method === "zero_based" && b.month >= month,
    );
    await db.budget_lines.bulkAdd(
      budgets.map((b) => ({
        id: crypto.randomUUID(),
        budget_id: b.id,
        category_id: category.id,
        planned_cents: 0,
      })),
    );
  });
  return category;
}

export async function updateCategory(
  db: StackdDb,
  id: string,
  changes: { name?: string; bucket?: Bucket; hidden?: boolean },
  now: Date = new Date(),
): Promise<void> {
  const current = await db.categories.get(id);
  if (!current) return;
  const patch: Partial<Category> = { updated_at: now.toISOString() };
  if (changes.name !== undefined) {
    const checked = checkName(changes.name, current.kind, await db.categories.toArray(), id);
    if ("problem" in checked) throw new Error(checked.problem);
    patch.name = checked.name;
  }
  if (changes.bucket !== undefined && current.kind === "expense") patch.bucket = changes.bucket;
  if (changes.hidden !== undefined && current.is_default) patch.hidden = changes.hidden;
  await db.categories.update(id, patch);
}

/** How many entries use each category, for the list and the remove sheet. */
export async function usageCounts(db: StackdDb): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await db.entries.each((e) => {
    if (e.category_id) counts.set(e.category_id, (counts.get(e.category_id) ?? 0) + 1);
  });
  return counts;
}

/**
 * Removes one of the person's own categories. Its entries, category rules, plan lines and
 * spend-less goals move to `moveTo` first (a plan line's amount adds to the target's line in the
 * same month), so no total changes except which category it shows under.
 */
export async function removeCategory(
  db: StackdDb,
  id: string,
  moveTo: string,
  now: Date = new Date(),
): Promise<void> {
  const stamp = now.toISOString();
  await db.transaction(
    "rw",
    [db.categories, db.entries, db.merchant_rules, db.budget_lines, db.goals, db.tombstones],
    async () => {
      const source = await db.categories.get(id);
      const target = await db.categories.get(moveTo);
      if (!source || source.is_default || !target || target.id === id) throw new Error("invalid");
      if (target.kind !== source.kind) throw new Error("invalid");
      await db.entries
        .where("category_id")
        .equals(id)
        .modify({ category_id: moveTo, updated_at: stamp });
      const rules = await db.merchant_rules.where("category_id").equals(id).toArray();
      for (const r of rules) await db.merchant_rules.update(r.id, { category_id: moveTo });
      const lines = await db.budget_lines.toArray();
      const gone: string[] = [];
      for (const line of lines.filter((l) => l.category_id === id)) {
        const into = lines.find((l) => l.budget_id === line.budget_id && l.category_id === moveTo);
        if (into) {
          await db.budget_lines.update(into.id, {
            planned_cents: into.planned_cents + line.planned_cents,
          });
          await db.budget_lines.delete(line.id);
          gone.push(line.id);
        } else {
          await db.budget_lines.update(line.id, { category_id: moveTo });
        }
      }
      await db.goals
        .filter((g) => g.category_id === id)
        .modify({ category_id: moveTo, label: target.name, updated_at: stamp });
      await db.categories.delete(id);
      await recordDeletion(db, "budget_lines", gone, now);
      await recordDeletion(db, "categories", [id], now);
    },
  );
}
