import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents } from "../../lib/format.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { ChipChoice } from "./ChipChoice.tsx";
import { leaveGroup, REPORT_REASONS, type ReportReason, splitErrorText } from "./useSplits.ts";

/**
 * Leave, or Report and leave (spec "Reports and blocks"). Leaving never forgives anything: a
 * balance stays with the group. A report counts against the organizer; 3 from 3 different
 * people pause their groups until support looks at it.
 */
export function LeaveSheet({
  groupId,
  organizerName,
  balance,
  open,
  startWithReport = false,
  onClose,
}: {
  groupId: string;
  organizerName: string;
  balance: number;
  open: boolean;
  startWithReport?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { db } = useDb();
  const { refresh } = useEntitlements();
  const [reporting, setReporting] = useState(startWithReport);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  async function leave() {
    if (reporting && !reason) return setError("Pick what's wrong first.");
    setBusy(true);
    const r = await leaveGroup(db, groupId, reporting ? reason : null);
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    await refresh(); // leaving a last group changes what a guest's app is
    onClose();
    navigate("/splits", { replace: true });
  }

  return (
    <Sheet open onClose={onClose} title={reporting ? "Report and leave" : "Leave group"}>
      {balance < 0 ? (
        <p>Leaving doesn't forgive anything: you still owe {formatCents(-balance)}.</p>
      ) : balance > 0 ? (
        <p>You're owed {formatCents(balance)}. Leaving keeps it with the group.</p>
      ) : (
        <p>You're settled up. Your bills stay in the group's history.</p>
      )}
      {reporting ? (
        <>
          <ChipChoice
            legend={`What's wrong with ${organizerName}?`}
            options={REPORT_REASONS}
            value={reason}
            onChange={(v) => {
              setReason(v);
              setError(null);
            }}
          />
          <p className="auth__hint">
            {organizerName} isn't told who reported. Qash looks at it when several people do.
          </p>
        </>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block variant="danger" onClick={leave} disabled={busy}>
        {reporting ? "Report and leave" : "Leave group"}
      </Button>
      {reporting ? null : (
        <Button block variant="ghost" onClick={() => setReporting(true)}>
          Something's wrong? Report and leave
        </Button>
      )}
    </Sheet>
  );
}
