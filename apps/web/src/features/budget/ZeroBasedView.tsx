import "../entries/entries.css";

import { Button, Card, ProgressBar, Sheet } from "@stackd/ui";
import { useId, useState } from "react";
import { Word, wordTone } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { BudgetLine, Category } from "../../data/db.ts";
import type { BudgetSummary, MonthTotals } from "../../engine/bridge.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { showUndo } from "../entries/undoToast.ts";
import type { PaceWord } from "./pace.ts";
import {
  assignRest,
  fillFromLastMonth,
  type MoveProblem,
  moveBetween,
  undoAssign,
  undoMove,
} from "./zeroBased.ts";

type Move = { from: string | null; to: string | null; amount: string };

const MOVE_PROBLEM: Record<MoveProblem, string> = {
  same: "Pick two different categories.",
  nothing: "Enter an amount to move.",
  too_much: "That's more than is planned there.",
};

/**
 * Zero-based budgeting (chunk 1.4; made complete October 23, 2026): every dollar of take-home
 * gets a job. Left to assign with "Assign what's left" and, on a fresh plan, "Start from last
 * month"; each line with what's spent and left, a bar, and "Cover it" when it's over; "Move
 * money" between lines; lines with nothing planned or spent folded away.
 */
export function ZeroBasedView({
  summary,
  lines,
  categories,
  lastMonth,
  pace = null,
}: {
  summary: BudgetSummary;
  lines: BudgetLine[];
  categories: Map<string, Category>;
  /** Last month's totals (Money in & out's), for "Start from last month". */
  lastMonth: MonthTotals | null;
  /** "Close" / "Over" per line from `budget.pace` (the same reading as the budget alert). */
  pace?: Map<string, PaceWord> | null;
}) {
  const { db } = useDb();
  const ids = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState(false);
  const [move, setMove] = useState<Move | null>(null);
  const [problem, setProblem] = useState("");
  const left = summary.left_to_assign_cents ?? 0;
  const spentFor = new Map(summary.categories.map((c) => [c.category_id, c.spent_cents]));
  const name = (line: BudgetLine) => categories.get(line.category_id)?.name ?? "Unknown";
  const ordered = [...lines].sort(
    (a, b) =>
      (categories.get(a.category_id)?.sort ?? 0) - (categories.get(b.category_id)?.sort ?? 0),
  );
  const active = ordered.filter(
    (l) => l.planned_cents > 0 || (spentFor.get(l.category_id) ?? 0) > 0,
  );
  const quiet = ordered.filter((l) => !active.includes(l));
  const lastSpent = new Map(
    (lastMonth?.by_category ?? []).map((c) => [c.category_id, c.out_cents] as const),
  );
  const canFill =
    lines.length > 0 &&
    lines.every((l) => l.planned_cents === 0) &&
    lines.some((l) => (lastSpent.get(l.category_id) ?? 0) > 0);

  async function commit(line: BudgetLine) {
    const text = drafts[line.id];
    if (text === undefined) return;
    try {
      const cents = text.trim() === "" ? 0 : await parseAmount(text);
      if (cents >= 0 && cents !== line.planned_cents)
        await db.budget_lines.update(line.id, { planned_cents: cents });
    } catch {
      /* keep the previous planned amount */
    }
    setDrafts((d) => {
      const next = { ...d };
      delete next[line.id];
      return next;
    });
  }

  async function doMove() {
    if (!move) return;
    const from = lines.find((l) => l.id === move.from);
    const to = lines.find((l) => l.id === move.to);
    if (!from || !to) return setProblem("Pick where it comes from and where it goes.");
    let cents = 0;
    try {
      cents = await parseAmount(move.amount);
    } catch {
      return setProblem("Enter an amount like 25.00.");
    }
    const issue = await moveBetween(db, from, to, cents);
    if (issue) return setProblem(MOVE_PROBLEM[issue]);
    setMove(null);
    showUndo(`Moved ${formatCents(cents)} from ${name(from)} to ${name(to)}`, () => {
      void undoMove(db, from.id, to.id, cents);
    });
  }

  function lineRow(line: BudgetLine) {
    const spent = spentFor.get(line.category_id) ?? 0;
    const remaining = line.planned_cents - spent;
    // Nothing planned isn't "over": it's a line still waiting for its job.
    const unplanned = line.planned_cents === 0;
    const over = !unplanned && spent > line.planned_cents;
    const label = name(line);
    const word = pace?.get(line.category_id) ?? null;
    return (
      <div className="zb-line" key={line.id}>
        <div className="zb-line__main">
          {word ? (
            <span className={`zb-line__word zb-line__word--${wordTone(word)}`}>{word}</span>
          ) : null}
          <button
            type="button"
            className="zb-line__name"
            aria-label={`Move money to or from ${label}`}
            onClick={() => {
              setProblem("");
              setMove({ from: null, to: line.id, amount: "" });
            }}
          >
            {label}
          </button>
          <div className={`zb-line__spent${over ? " zb-line__spent--over" : ""}`}>
            {unplanned
              ? `${formatCents(spent)} spent · nothing planned yet`
              : `${formatCents(spent)} of ${formatCents(line.planned_cents)} · ${
                  over ? `${formatCents(-remaining)} over` : `${formatCents(remaining)} left`
                }`}
          </div>
          {line.planned_cents > 0 ? (
            <ProgressBar
              fraction={spent / line.planned_cents}
              label={`${label} spent of planned`}
              valueText={`${formatCents(spent)} of ${formatCents(line.planned_cents)}`}
              tone={over ? "warning" : undefined}
            />
          ) : null}
          {over ? (
            <button
              type="button"
              className="auth__link zb-line__cover"
              onClick={() => {
                setProblem("");
                setMove({ from: null, to: line.id, amount: (-remaining / 100).toFixed(2) });
              }}
            >
              Cover it
            </button>
          ) : null}
        </div>
        <input
          aria-label={`${label} planned`}
          inputMode="decimal"
          value={
            drafts[line.id] ??
            (line.planned_cents === 0 ? "" : (line.planned_cents / 100).toFixed(2))
          }
          placeholder="0.00"
          onChange={(e) => setDrafts((d) => ({ ...d, [line.id]: e.target.value }))}
          onBlur={() => commit(line)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
    );
  }

  const fromChoices = lines.filter((l) => l.planned_cents > 0 && l.id !== move?.to);
  return (
    <>
      <Card tone="accent" as="section" aria-label="Left to assign">
        <Word>{left === 0 ? "Done" : left < 0 ? "Over" : "Assign"}</Word>
        <p className="sk-card__eyebrow">{left < 0 ? "Over-assigned" : "Left to assign"}</p>
        <p className="sk-card__hero">{formatCents(Math.abs(left))}</p>
        <p>
          {left === 0
            ? "Every dollar has a job."
            : left < 0
              ? "Planned lines add up to more than your take-home. Lower one, or move money."
              : "Give every dollar a job until $0 is left."}
        </p>
        <div className="zb-actions">
          {left > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => setAssigning(true)}>
              Assign what's left
            </Button>
          ) : null}
          {canFill ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                const n = await fillFromLastMonth(db, lines, lastSpent);
                showUndo(
                  `Planned ${n} ${n === 1 ? "category" : "categories"} from last month`,
                  () => {
                    void db.budget_lines.bulkPut(lines);
                  },
                );
              }}
            >
              Start from last month
            </Button>
          ) : null}
          {lines.some((l) => l.planned_cents > 0) ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setProblem("");
                setMove({ from: null, to: null, amount: "" });
              }}
            >
              Move money
            </Button>
          ) : null}
        </div>
      </Card>
      <Card as="section" aria-label="Planned by category">
        {active.length ? active.map(lineRow) : <p>Nothing planned yet. Type an amount below.</p>}
        {quiet.length ? (
          <details className="zb-quiet" open={active.length === 0}>
            <summary>
              {quiet.length} {quiet.length === 1 ? "category" : "categories"} with nothing planned
            </summary>
            {quiet.map(lineRow)}
          </details>
        ) : null}
      </Card>

      <Sheet open={assigning} onClose={() => setAssigning(false)} title="Assign what's left">
        <p>Put {formatCents(left)} into:</p>
        <div className="chips">
          {ordered.map((line) => (
            <button
              type="button"
              className="chip-option"
              key={line.id}
              onClick={async () => {
                const amount = left;
                await assignRest(db, line, amount);
                setAssigning(false);
                showUndo(`${formatCents(amount)} assigned to ${name(line)}`, () => {
                  void undoAssign(db, line.id, amount);
                });
              }}
            >
              {name(line)}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={move !== null} onClose={() => setMove(null)} title="Move money">
        {move ? (
          <>
            <label className="auth__field" htmlFor={`${ids}-amount`}>
              <span className="auth__label">Amount</span>
              <input
                id={`${ids}-amount`}
                className="auth__input"
                inputMode="decimal"
                placeholder="25.00"
                value={move.amount}
                onChange={(e) => setMove({ ...move, amount: e.target.value })}
              />
            </label>
            <fieldset className="chips" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="auth__label">From</legend>
              {fromChoices.map((line) => (
                <label className="chip-option" key={line.id}>
                  <input
                    className="segmented__input"
                    type="radio"
                    name={`${ids}-from`}
                    checked={move.from === line.id}
                    onChange={() => setMove({ ...move, from: line.id })}
                  />
                  {name(line)} · {formatCents(line.planned_cents)}
                </label>
              ))}
            </fieldset>
            <fieldset className="chips" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="auth__label">To</legend>
              {ordered
                .filter((l) => l.id !== move.from)
                .map((line) => (
                  <label className="chip-option" key={line.id}>
                    <input
                      className="segmented__input"
                      type="radio"
                      name={`${ids}-to`}
                      checked={move.to === line.id}
                      onChange={() => setMove({ ...move, to: line.id })}
                    />
                    {name(line)}
                  </label>
                ))}
            </fieldset>
            {problem ? (
              <p className="auth__error" role="alert">
                {problem}
              </p>
            ) : null}
            <Button block onClick={() => void doMove()}>
              Move
            </Button>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
