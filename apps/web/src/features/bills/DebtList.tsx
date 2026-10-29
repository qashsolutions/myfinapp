import "../groups/groups.css";

import { Button, Card, Chip, Illustration } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { type Debt, ignoreClosed } from "../../data/db.ts";
import { type AvalancheOrder, avalancheOrder, payoffPlan } from "../../engine/bridge.ts";
import { formatCents, todayIso } from "../../lib/format.ts";
import { bankName } from "../linking/anchorText.ts";
import { type CardInPlan, cardName, debtInputs, useDebtSettings } from "./debtPlan.ts";

export function aprText(bps: number): string {
  return `${(bps / 100).toFixed(2)}% APR`;
}

/** Cards and loans in the order the person picked (mockup F5Bills; highest rate first unless
 * they chose smallest balance first): the top one is where extra payments go. */
export function DebtList({
  onEdit,
  onCard,
}: {
  onEdit: (debt: Debt) => void;
  /** A linked card's row: its own sheet (APR when the issuer sent none, count it, same card). */
  onCard: (accountId: string) => void;
}) {
  const settings = useDebtSettings();
  const debts = settings?.debts;
  const kind = settings?.order ?? "avalanche";
  // The rows and the order they were worked out in, set together: the list's name and note
  // follow the rows on screen, never a newer choice whose rows are still being worked out.
  const [state, setState] = useState<{ order: AvalancheOrder; kind: typeof kind } | null>(null);
  const order = state?.order ?? null;
  const shown = state?.kind ?? kind;
  useEffect(() => {
    if (!debts) return;
    let alive = true;
    void (async () => {
      const totals = await avalancheOrder(debts);
      if (kind === "snowball" && debts.length > 0) {
        // The same rule's own order, so the list and the plan never disagree.
        const plan = await payoffPlan(debtInputs(debts), 0, todayIso(), "snowball");
        const byId = new Map(totals.order.map((d) => [d.id, d]));
        totals.order = plan.order.flatMap((p) => {
          const d = byId.get(p.id);
          return d ? [{ ...d, rank: p.rank }] : [];
        });
      }
      if (alive) setState({ order: totals, kind });
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [debts, kind]);
  const byId = new Map((debts ?? []).map((d) => [d.id, d]));
  const cards = settings?.cards ?? [];
  const needs = cards.filter((c) => c.status === "needs");
  const twice =
    (settings?.unpaired.length ?? 0) > 0 && cards.some((c) => c.status === "in_plan" && !c.paired);
  return (
    <>
      {needs.map((c) => (
        <CardNeedsRate key={c.account.id} card={c} onOpen={() => onCard(c.account.id)} />
      ))}
      {twice ? (
        <Card as="div" role="note" aria-label="Counted twice?">
          <Word>Review</Word>
          <p>
            Added a linked card by hand too? Open the card below and pick which debt it is, so it
            counts once.
          </p>
        </Card>
      ) : null}
      {order && order.order.length === 0 && needs.length === 0 ? (
        <Card>
          <Illustration name="card" tone="a3" />
          <p>
            No cards or loans yet. Add each one with its balance, APR and minimum payment, and the
            app orders them the way you pick in the payoff plan: pay minimums on all, extra on the
            first. Nothing is moved for you.
          </p>
        </Card>
      ) : null}
      {order && order.order.length > 0 ? (
        <p className="group-row__meta">
          Balances {formatCents(order.total_balance_cents)} · minimums{" "}
          {formatCents(order.total_min_payment_cents)} a month
        </p>
      ) : null}
      <ol
        className="lb"
        aria-label={
          shown === "snowball" ? "Debts, smallest balance first" : "Debts, highest rate first"
        }
      >
        {order?.order.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="card-link"
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                border: 0,
                padding: 0,
              }}
              onClick={() => {
                const row = byId.get(d.id);
                if (row?.card_account_id) onCard(row.card_account_id);
                else if (row) onEdit(row);
              }}
              aria-label={`${d.label}, ${aprText(d.apr_bps)}, balance ${formatCents(d.balance_cents)}, rank ${d.rank}`}
            >
              <Card as="div" className={d.rank === 1 ? "suggestion" : undefined}>
                <div className="goal-card__top">
                  <span className="lb__name">
                    <span className="lb__avatar" aria-hidden="true">
                      {d.rank}
                    </span>
                    <span>{d.label}</span>
                  </span>
                  <span className="lb__pct">{formatCents(d.balance_cents)}</span>
                </div>
                <p className="group-row__meta">
                  {byId.get(d.id)?.card_account_id ? (
                    <>
                      <Chip tone="accent">Linked</Chip>{" "}
                    </>
                  ) : null}
                  {aprText(d.apr_bps)} · min {formatCents(d.min_payment_cents)}
                  {d.rank === 1 ? " · extra payments go here" : ""}
                </p>
              </Card>
            </button>
          </li>
        ))}
      </ol>
      {order && order.order.length > 0 ? (
        <p className="auth__fineprint">
          {shown === "snowball"
            ? "Smallest balance first: a debt clears sooner. Education, not advice."
            : "Highest rate first: interest costs the least. Education, not advice."}
        </p>
      ) : null}
    </>
  );
}

/** A linked card the plan can't count yet: ask once for what the issuer didn't send. */
function CardNeedsRate({ card, onOpen }: { card: CardInPlan; onOpen: () => void }) {
  const missing = [
    card.apr_bps === null ? "APR" : null,
    card.min_payment_cents === null ? "minimum payment" : null,
  ].filter((x): x is string => x !== null);
  const name = cardName(card.account);
  const line =
    card.owed_cents === null
      ? `${bankName(card.account)} hasn't sent ${name}'s balance yet. It joins the plan after the next sync.`
      : `${bankName(card.account)} didn't send ${name}'s ${missing.join(" or ")}. Add it once and the card joins the plan.`;
  return (
    <Card as="div" role="group" aria-label={`${name} needs details`}>
      <Word>Review</Word>
      <p>{line}</p>
      {card.owed_cents !== null ? (
        <Button size="sm" onClick={onOpen}>
          Add {missing.join(" and ")}
        </Button>
      ) : null}
    </Card>
  );
}
