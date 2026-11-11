import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { shortDate, shortTime } from "../../lib/dates.ts";
import { canUndo, groupHistory } from "./ledger.ts";
import type { SplitView } from "./splitSync.ts";
import {
  authorityOf,
  namesOf,
  type SplitGroupOut,
  splitErrorText,
  undoPayment,
} from "./useSplits.ts";

/**
 * A group's History (S.7, November 10, 2026): bills added, approved and changed, payments with
 * their notes, undone payments and disputes, newest first, built on this device. A payment I
 * recorded can be undone here within 7 days.
 */
export function GroupHistorySheet({
  group,
  view,
  open,
  onClose,
  onChanged,
}: {
  group: SplitGroupOut;
  view: SplitView;
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { db } = useDb();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const nameOf = namesOf(group);
  const items = groupHistory(view.merged, authorityOf(group), nameOf, view.disputes);
  const now = new Date();

  async function undo(id: string) {
    setBusy(true);
    const r = await undoPayment(db, group, id);
    setBusy(false);
    setNote(r.ok ? "Undone. It no longer counts." : splitErrorText(r.code));
    await onChanged();
  }

  return (
    <Sheet open onClose={onClose} title="History">
      {items.length === 0 ? <p>Nothing yet.</p> : null}
      <ul className="sk-list bill-history" aria-label="Group history">
        {items.map((h) => (
          <li key={`${h.at}-${h.text}`} className="split-pay">
            <span className="split-pay__text">
              {h.text}
              {h.at ? (
                <span className="auth__fineprint">
                  {" "}
                  {shortDate(h.at)}, {shortTime(h.at)}
                </span>
              ) : null}
            </span>
            {h.settlement && canUndo(h.settlement, h.settlement.by, group.my_member_id, now) ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void undo(h.settlement?.id ?? "")}
              >
                Undo
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {note ? <p role="status">{note}</p> : null}
    </Sheet>
  );
}
