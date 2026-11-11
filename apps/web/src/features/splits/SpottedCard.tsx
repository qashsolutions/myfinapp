import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { settleRef } from "./settleSpending.ts";
import type { SplitView } from "./splitSync.ts";
import { type Spot, spotted } from "./spotted.ts";
import {
  namesOf,
  notifyMember,
  recordPayment,
  type SplitGroupOut,
  splitErrorText,
} from "./useSplits.ts";

const TURNED_DOWN = "split.spotted_no";

/**
 * Spotted (spec "Settling up"): on Connected, a linked bank row that matches a payment due in
 * this group is suggested, never applied. Mark settled records the payment and marks the row
 * (money in: Paid back, never income; money out: it already counts as my spending, once).
 */
export function SpottedCard({
  group,
  view,
  onChanged,
}: {
  group: SplitGroupOut;
  view: SplitView;
  onChanged: () => Promise<void>;
}) {
  const { db } = useDb();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const me = group.my_member_id;
  const nameOf = namesOf(group);
  const spots = useLiveQuery(async () => {
    const linked = (await db.entries.where("provider_txn_id").above("").toArray()) ?? [];
    const no = (await db.settings.get(TURNED_DOWN))?.value;
    const dismissed = new Set(Array.isArray(no) ? (no as string[]) : []);
    return spotted(
      view.payments,
      me,
      linked,
      dismissed,
      todayIso(),
      (id) => group.members.find((m) => m.member_id === id)?.display_name ?? "",
    );
  }, [db, view.payments, me, group.members]);
  if (!spots || spots.length === 0) return null;

  async function settle(s: Spot) {
    setBusy(true);
    const r = await recordPayment(db, group, { ...s.payment, via: s.app });
    if (r.ok) {
      const now = new Date().toISOString();
      if (s.direction === "in")
        await db.entries.update(s.entry.id, {
          paid_back: true,
          not_counted: true,
          updated_at: now,
        });
      else
        await db.entries.update(s.entry.id, {
          split_settle: settleRef(group.id, r.id),
          updated_at: now,
        });
      const counts = s.payment.to === me || group.is_organizer;
      if (!counts && s.payment.from === me) void notifyMember(group.id, "paid", s.payment.to);
      else if (counts && s.payment.from !== me)
        void notifyMember(group.id, "confirmed", s.payment.from);
    }
    setBusy(false);
    setNote(r.ok ? "Marked settled." : splitErrorText(r.code));
    await onChanged();
  }

  async function notThis(s: Spot) {
    const no = (await db.settings.get(TURNED_DOWN))?.value;
    const list = Array.isArray(no) ? (no as string[]) : [];
    await db.settings.put({
      key: TURNED_DOWN,
      value: [...list.filter((id) => id !== s.entry.id), s.entry.id].slice(-200),
      updated_at: new Date().toISOString(),
    });
  }

  return (
    <Card as="section" aria-label="Spotted">
      <Word>Spotted</Word>
      {spots.map((s) => {
        const who = s.direction === "in" ? nameOf(s.payment.from) : nameOf(s.payment.to);
        const text =
          s.direction === "in"
            ? `${formatCents(s.entry.amount_cents)} came in by ${s.appLabel} on ${formatDay(s.entry.date)}. Is it ${who} paying you?`
            : `${formatCents(s.entry.amount_cents)} went out by ${s.appLabel} on ${formatDay(s.entry.date)}. Is it you paying ${who}?`;
        return (
          <div className="split-pay" key={s.entry.id}>
            <span className="split-pay__text">{text}</span>
            <span className="split-pay__actions">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void settle(s)}>
                Mark settled
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void notThis(s)}>
                Not this
              </Button>
            </span>
          </div>
        );
      })}
      {note ? <p role="status">{note}</p> : null}
    </Card>
  );
}
