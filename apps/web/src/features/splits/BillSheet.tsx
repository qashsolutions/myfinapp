import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { shortDate, shortTime } from "../../lib/dates.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { billHistory, type ShownBill } from "./ledger.ts";
import type { SplitView } from "./splitSync.ts";
import {
  authorityOf,
  closeDispute,
  disputeBill,
  namesOf,
  type SplitGroupOut,
  splitErrorText,
} from "./useSplits.ts";

const REPEATS = { weekly: "every week", monthly: "every month", yearly: "every year" } as const;

/**
 * One bill: who paid, each person's part, and a dispute (spec "Balances"): a disputed bill is on
 * hold for everyone until the organizer fixes it or the disputer withdraws.
 */
export function BillSheet({
  group,
  view,
  bill,
  onClose,
  onChanged,
}: {
  group: SplitGroupOut;
  view: SplitView;
  bill: ShownBill | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!bill) return null;
  const nameOf = namesOf(group);
  const me = group.my_member_id;
  const mineOpen = view.disputes.some((d) => d.bill_id === bill.base_id && d.member_id === me);
  const involved = bill.paid_by === me || bill.parts.some((p) => p.person === me);

  async function run(action: () => ReturnType<typeof disputeBill>) {
    setBusy(true);
    const r = await action();
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    await onChanged();
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title={bill.what}>
      <p>
        {formatCents(bill.amount_cents)} · {formatDay(bill.date)} · {nameOf(bill.paid_by)} paid
        {bill.repeat ? ` · ${REPEATS[bill.repeat]}` : ""}
        {bill.edited ? " · Edited by the organizer" : ""}
      </p>
      <ul className="sk-list" aria-label="Who owes what">
        {bill.parts.map((p) => (
          <li className="split-pay" key={p.person}>
            <span className="split-pay__text">{nameOf(p.person)}</span>
            <span>{formatCents(p.cents)}</span>
          </li>
        ))}
      </ul>
      {bill.disputed ? (
        <p role="status">On hold: someone disputed this bill. It moves nobody until it's fixed.</p>
      ) : null}
      <section aria-labelledby="bill-history-h">
        <h3 className="auth__label" id="bill-history-h">
          History
        </h3>
        <ul className="sk-list bill-history">
          {billHistory(bill, authorityOf(group), nameOf).map((h) => (
            <li key={`${h.at}-${h.text}`}>
              <span>{h.text}</span>{" "}
              <span className="auth__fineprint">
                {shortDate(h.at)}, {shortTime(h.at)}
              </span>
            </li>
          ))}
          {view.disputes
            .filter((d) => d.bill_id === bill.base_id)
            .map((d) => (
              <li key={`dispute-${d.member_id ?? "x"}`}>
                Disputed by {d.member_id ? nameOf(d.member_id) : "a former member"} · open
              </li>
            ))}
        </ul>
      </section>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {group.is_organizer && group.writable ? (
        <Button
          block
          variant="secondary"
          onClick={() => navigate(`/splits/${group.id}/bills/${bill.base_id}`)}
        >
          {bill.disputed ? "Fix it" : "Edit"}
        </Button>
      ) : null}
      {group.is_organizer && bill.disputed ? (
        <Button
          block
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => closeDispute(group.id, bill.base_id))}
        >
          It's fixed · take it off hold
        </Button>
      ) : null}
      {!group.is_organizer && mineOpen ? (
        <Button
          block
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => closeDispute(group.id, bill.base_id))}
        >
          Withdraw my dispute
        </Button>
      ) : null}
      {!group.is_organizer && !mineOpen && involved ? (
        <Button
          block
          variant="ghost"
          disabled={busy}
          onClick={() => run(() => disputeBill(group.id, bill.base_id))}
        >
          This isn't right · Dispute
        </Button>
      ) : null}
    </Sheet>
  );
}
