import "../entries/entries.css";

import { Button, Card } from "@stackd/ui";
import { useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { ReceiptRetention } from "../../data/db.ts";
import { RETENTION_LABELS, removeReceiptPhoto, setRetention } from "../../data/receipts.ts";
import { todayIso } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { useRetention } from "./useReceipts.ts";

/** Settings → Receipts & your data: how long receipt photos stay on this device. */
export function RetentionSettings() {
  const { db } = useDb();
  const ids = useId();
  const retention = useRetention();
  const [confirm, setConfirm] = useState(false);
  async function deleteAll() {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    const withPhoto = await db.receipts.filter((r) => r.file_id !== null).toArray();
    for (const r of withPhoto) await removeReceiptPhoto(db, r.id);
    setConfirm(false);
  }
  return (
    <Card as="section" aria-labelledby="receipts-h">
      <h2 className="sk-card__title" id="receipts-h">
        Receipt photos
      </h2>
      <p>
        Photos stay on this device only. After this long they are removed; the amounts you entered
        stay.
      </p>
      <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0 0" }}>
        <legend className="sr-only">Keep receipt photos for</legend>
        <ChoiceChips
          name={`${ids}-retention`}
          options={(Object.keys(RETENTION_LABELS) as ReceiptRetention[]).map((k) => [
            k,
            RETENTION_LABELS[k],
          ])}
          value={retention}
          onPick={(v) => void setRetention(db, v as ReceiptRetention, todayIso())}
        />
      </fieldset>
      <Button variant="ghost" size="sm" onClick={deleteAll}>
        <span style={{ color: "var(--c-danger)" }}>
          {confirm ? "Really delete every receipt photo" : "Delete all receipt photos"}
        </span>
      </Button>
    </Card>
  );
}
