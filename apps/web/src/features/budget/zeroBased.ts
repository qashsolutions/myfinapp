/**
 * Zero-based budgeting moves (October 23, 2026): every dollar of take-home gets a job. These are
 * bookkeeping on the person's own plan lines (planned cents they typed); every total shown still
 * comes from `budget.summary`.
 */

import type { BudgetLine, StackdDb } from "../../data/db.ts";

/** Put what's left to assign into one line: added to what is stored now, never to the screen's
 * copy, so a typed amount saved a moment before is kept (October 27, 2026). */
export async function assignRest(db: StackdDb, line: BudgetLine, cents: number): Promise<void> {
  if (cents <= 0) return;
  await db.transaction("rw", db.budget_lines, async () => {
    const now = await db.budget_lines.get(line.id);
    if (now) await db.budget_lines.update(line.id, { planned_cents: now.planned_cents + cents });
  });
}

/** Undo an assign: takes back that amount, keeping any edit made since; never below zero. */
export async function undoAssign(db: StackdDb, lineId: string, cents: number): Promise<void> {
  await db.transaction("rw", db.budget_lines, async () => {
    const now = await db.budget_lines.get(lineId);
    if (now)
      await db.budget_lines.update(lineId, {
        planned_cents: Math.max(0, now.planned_cents - cents),
      });
  });
}

export type MoveProblem = "same" | "nothing" | "too_much";

/** Move planned money from one line to another; never below zero on the line it leaves. Checked
 * and applied against what is stored now. */
export async function moveBetween(
  db: StackdDb,
  from: BudgetLine,
  to: BudgetLine,
  cents: number,
): Promise<MoveProblem | null> {
  if (from.id === to.id) return "same";
  if (cents <= 0) return "nothing";
  return db.transaction("rw", db.budget_lines, async () => {
    const source = await db.budget_lines.get(from.id);
    const target = await db.budget_lines.get(to.id);
    if (!source || !target) return "nothing" as const;
    if (cents > source.planned_cents) return "too_much" as const;
    await db.budget_lines.update(from.id, { planned_cents: source.planned_cents - cents });
    await db.budget_lines.update(to.id, { planned_cents: target.planned_cents + cents });
    return null;
  });
}

/** Undo a move: the amount goes back, keeping any edit made since; never below zero. */
export async function undoMove(
  db: StackdDb,
  fromId: string,
  toId: string,
  cents: number,
): Promise<void> {
  await db.transaction("rw", db.budget_lines, async () => {
    const source = await db.budget_lines.get(fromId);
    const target = await db.budget_lines.get(toId);
    if (!source || !target) return;
    const back = Math.min(cents, target.planned_cents);
    await db.budget_lines.update(toId, { planned_cents: target.planned_cents - back });
    await db.budget_lines.update(fromId, { planned_cents: source.planned_cents + back });
  });
}

/**
 * A fresh plan from last month: each line with nothing planned takes what was spent in its
 * category last month (money out less refunds, from `cashflow.month_totals`), never below zero.
 * Lines the person already planned are left alone.
 */
export async function fillFromLastMonth(
  db: StackdDb,
  lines: BudgetLine[],
  spentLastMonth: Map<string | null, number>,
): Promise<number> {
  let filled = 0;
  await db.transaction("rw", db.budget_lines, async () => {
    for (const line of lines) {
      const spent = spentLastMonth.get(line.category_id) ?? 0;
      const stored = await db.budget_lines.get(line.id); // a typed amount saved since is kept
      if (!stored || stored.planned_cents !== 0 || spent <= 0) continue;
      await db.budget_lines.update(line.id, { planned_cents: spent });
      filled += 1;
    }
  });
  return filled;
}
