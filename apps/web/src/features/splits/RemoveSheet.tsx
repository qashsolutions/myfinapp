import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents } from "../../lib/format.ts";
import type { SplitView } from "./splitSync.ts";
import {
  recordPayment,
  removeFromGroup,
  type SplitGroupOut,
  type SplitMemberOut,
  splitErrorText,
} from "./useSplits.ts";

/**
 * Remove someone (spec "Leaving and removing"): never with a balance. Someone who owes can be
 * forgiven: the organizer records what they owe as paid, then removes them. Someone owed money
 * is settled first. Their bills stay with the group, so nobody else's balance moves.
 */
export function RemoveSheet({
  group,
  view,
  member,
  onClose,
  onDone,
}: {
  group: SplitGroupOut;
  view: SplitView;
  member: SplitMemberOut | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { db } = useDb();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!member) return null;
  const cents = view.balances.find((b) => b.person === member.member_id)?.cents ?? 0;
  const name = member.display_name;

  async function remove(forgive: boolean) {
    if (!member) return;
    setBusy(true);
    if (forgive) {
      for (const p of view.payments.filter((x) => x.from === member.member_id)) {
        const r = await recordPayment(db, group, { ...p, via: "other" });
        if (!r.ok) {
          setBusy(false);
          return setError(splitErrorText(r.code));
        }
      }
    }
    const r = await removeFromGroup(group.id, member.member_id);
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    await onDone();
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title={`Remove ${name}`}>
      {cents === 0 ? (
        <>
          <p>{name} is settled up. Their bills stay in the group's history.</p>
          <Button block variant="danger" onClick={() => remove(false)} disabled={busy}>
            Remove {name}
          </Button>
        </>
      ) : cents < 0 ? (
        <>
          <p>
            Settle first: {name} owes {formatCents(-cents)}. Or forgive it and remove them.
          </p>
          <Button block variant="danger" onClick={() => remove(true)} disabled={busy}>
            Forgive {formatCents(-cents)} and remove
          </Button>
        </>
      ) : (
        <p>
          Settle first: the group owes {name} {formatCents(cents)}. Mark it paid, then remove them.
        </p>
      )}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block variant="ghost" onClick={onClose}>
        Keep {name}
      </Button>
    </Sheet>
  );
}
