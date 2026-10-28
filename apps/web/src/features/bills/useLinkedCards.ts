import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, type CardDetail, ignoreClosed, type PaySettings } from "../../data/db.ts";
import {
  addDays,
  cardUtilization,
  nextPaydays,
  type PayInFull,
  payInFull,
  type Utilization,
} from "../../engine/bridge.ts";
import { compareText } from "../../lib/order.ts";
import { emitMoment } from "../../moments/bus.ts";
import { payScheduleOf } from "../home/useHome.ts";

export interface LinkedCardView {
  account: Account;
  detail: CardDetail;
  utilization: Utilization;
  plan: PayInFull | null;
}

/**
 * Chunk 3.5: every linked credit card with issuer facts on this device, its utilisation and
 * its pay-in-full plan over Budget's paydays. All numbers come from the engine; a card paid in
 * full since its statement is a `card_paid` moment (once a month per card).
 */
export function useLinkedCards(asOf: string): LinkedCardView[] | undefined {
  const { db } = useDb();
  const source = useLiveQuery(async () => {
    const [details, accounts, anchors, pay] = await Promise.all([
      db.card_details.toArray(),
      db.accounts.toArray(),
      db.balance_anchors.toArray(),
      db.settings.get("pay"),
    ]);
    return { details, accounts, anchors, pay: pay?.value as PaySettings | undefined };
  }, [db]);
  const [views, setViews] = useState<LinkedCardView[] | undefined>(undefined);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    void (async () => {
      const schedule = payScheduleOf(source.pay);
      // Paydays from today on: start the schedule the day before so today counts.
      const paydays = schedule ? await nextPaydays(await addDays(asOf, -1), schedule, 8) : [];
      const out: LinkedCardView[] = [];
      for (const detail of source.details) {
        const account = source.accounts.find((a) => a.id === detail.account_id && a.linked);
        if (!account) continue; // unlinked since: the facts are stale, so not shown
        const latest = source.anchors
          .filter((a) => a.account_id === account.id)
          .sort((a, b) => compareText(b.as_of, a.as_of))[0];
        // A card's anchor is negative (what is owed); utilisation wants the amount owed.
        const owed = latest ? -latest.balance_cents : null;
        const utilization = await cardUtilization(
          detail.statement_balance_cents,
          owed,
          detail.limit_cents,
        );
        const plan =
          detail.statement_balance_cents === null
            ? null
            : await payInFull({
                asOf,
                statementBalanceCents: detail.statement_balance_cents,
                statementDate: detail.statement_date,
                lastPaymentCents: detail.last_payment_cents,
                lastPaymentDate: detail.last_payment_date,
                dueDate: detail.due_date,
                paydays,
              });
        if (plan?.status === "paid")
          emitMoment(
            "card_paid",
            { card: account.label },
            `${account.id}:${detail.statement_date}`,
          );
        out.push({ account, detail, utilization, plan });
      }
      if (alive) setViews(out);
    })().catch(ignoreClosed);
    return () => {
      alive = false;
    };
  }, [source, asOf]);
  return views;
}
