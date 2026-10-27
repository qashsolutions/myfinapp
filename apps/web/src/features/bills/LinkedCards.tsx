import "./cards.css";

import { Card, Chip, ProgressBar } from "@stackd/ui";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { cardText, type MomentType } from "../../moments/catalog.ts";
import { aprText } from "./DebtList.tsx";
import { type LinkedCardView, useLinkedCards } from "./useLinkedCards.ts";

/**
 * Chunk 3.5 (Connected): each linked card as the issuer reports it. Visual first: the
 * statement balance, a due-date countdown, the share of the limit in use, then the plan to pay
 * the statement in full split across paydays. Read-only: nothing here moves money.
 */
export function LinkedCards() {
  const cards = useLinkedCards(todayIso());
  if (!cards || cards.length === 0) return null;
  return (
    <section aria-labelledby="linked-cards-h" className="linked-cards">
      <h2 className="section-title" id="linked-cards-h">
        Your cards
      </h2>
      {cards.map((c) => (
        <CardFacts key={c.account.id} view={c} />
      ))}
      <p className="auth__fineprint">
        From your card issuer through your bank link, read-only. Qash never pays or moves money.
      </p>
    </section>
  );
}

function dueChip(days: number | null, overdue: boolean) {
  if (overdue || (days !== null && days < 0)) return <Chip tone="danger">Past due</Chip>;
  if (days === null) return null;
  const text = days === 0 ? "Due today" : `Due in ${days} ${days === 1 ? "day" : "days"}`;
  return <Chip tone={days <= 3 ? "warning" : "neutral"}>{text}</Chip>;
}

function planLine(view: LinkedCardView): string | null {
  const plan = view.plan;
  if (!plan) return null;
  const date = plan.due_date ? formatDay(plan.due_date) : "";
  const amount = formatCents(plan.remaining_cents);
  const type: Record<string, MomentType | null> = {
    plan: "card_plan",
    no_payday: "card_no_payday",
    paid: "card_paid",
    past_due: "card_past_due",
    no_due_date: "card_no_due_date",
    no_balance: null,
  };
  const t = type[plan.status];
  return t ? cardText(t, { amount, date, card: view.account.label }, view.account.id) : null;
}

function CardFacts({ view }: { view: LinkedCardView }) {
  const { account, detail, utilization, plan } = view;
  const name = `${account.label}${account.last4 ? ` ••${account.last4}` : ""}`;
  const pct = utilization.utilization_bps;
  const line = planLine(view);
  return (
    <Card as="article" aria-label={name} className="card-facts">
      <div className="card-facts__top">
        <span className="card-facts__name">{name}</span>
        {dueChip(plan?.days_left ?? null, detail.is_overdue)}
      </div>
      <p className="card-facts__balance">
        {detail.statement_balance_cents !== null
          ? formatCents(detail.statement_balance_cents)
          : "No statement yet"}
        <span className="card-facts__sub">
          {detail.statement_date ? `Statement ${formatDay(detail.statement_date)}` : "Statement"}
          {detail.due_date ? ` · due ${formatDay(detail.due_date)}` : ""}
        </span>
      </p>

      {pct !== null && detail.limit_cents ? (
        <div className="card-facts__use">
          <ProgressBar
            fraction={pct / 10000}
            label={`${name} limit used`}
            valueText={`${Math.round(pct / 100)}% of ${formatCents(detail.limit_cents)} limit`}
            showText
            tone={pct >= 10000 ? "danger" : pct >= 3000 ? "warning" : "accent"}
          />
          <p className="card-facts__hint">Lenders look at how much of your limit you use.</p>
        </div>
      ) : null}

      <dl className="card-facts__grid">
        <div>
          <dt>Minimum</dt>
          <dd>{detail.minimum_cents !== null ? formatCents(detail.minimum_cents) : "—"}</dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>{detail.limit_cents !== null ? formatCents(detail.limit_cents) : "—"}</dd>
        </div>
        <div>
          <dt>APR</dt>
          <dd>{detail.apr_bps !== null ? aprText(detail.apr_bps).replace(" APR", "") : "—"}</dd>
        </div>
      </dl>

      {line ? <p className="insight__kind">{line}</p> : null}
      {plan && plan.status === "plan" && plan.payments.length > 1 ? (
        <ul className="card-facts__split" aria-label="Split across your paydays">
          {plan.payments.map((p) => (
            <li key={p.date}>
              <strong>{formatCents(p.amount_cents)}</strong> {formatDay(p.date)}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
