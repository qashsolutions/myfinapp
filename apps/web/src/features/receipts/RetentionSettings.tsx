import "../entries/entries.css";

import { Button, Card, Sheet } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { ReceiptRetention } from "../../data/db.ts";
import {
  deleteAllReceiptPhotos,
  MAX_RETENTION_DAYS,
  photosRemovedBy,
  RETENTION_LABELS,
  retentionLabel,
  setRetention,
} from "../../data/receipts.ts";
import { todayIso } from "../../lib/format.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { useRetention } from "./useReceipts.ts";

const photos = (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`;

/** What the confirm sheet is about: every photo, or the ones a shorter keep time removes. */
type Ask = { kind: "all"; n: number } | { kind: "shorten"; n: number; retention: ReceiptRetention };

/**
 * Settings → Receipts & your data: how long receipt photos stay on this device. Anything that
 * deletes photos at once (Delete all, or a shorter keep time) asks first with the real count
 * (owner decision, October 28, 2026): photos are on this phone only and never in the backup.
 */
export function RetentionSettings() {
  const { db } = useDb();
  const ids = useId();
  const retention = useRetention();
  const stored = useLiveQuery(() => db.receipts.filter((r) => r.file_id !== null).count(), [db]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function pick(next: ReceiptRetention) {
    setDone(null);
    const n = await photosRemovedBy(db, next, todayIso());
    if (n > 0) setAsk({ kind: "shorten", n, retention: next });
    else await setRetention(db, next, todayIso());
  }

  async function confirm() {
    if (!ask) return;
    const current = ask;
    setAsk(null);
    if (current.kind === "all") {
      const n = await deleteAllReceiptPhotos(db);
      setDone(`${photos(n)} deleted from this phone.`);
    } else {
      await setRetention(db, current.retention, todayIso());
      setDone(`${photos(current.n)} deleted from this phone.`);
    }
  }

  const count = stored ?? 0;
  return (
    <Card as="section" aria-labelledby="receipts-h">
      <h2 className="sk-card__title" id="receipts-h">
        Receipt photos
      </h2>
      <p>
        Photos stay on this device only. After this long they are removed; the amounts you entered
        stay.
      </p>
      <ChipsOrOwn
        name={`${ids}-retention`}
        legend="Keep receipt photos for"
        options={(Object.keys(RETENTION_LABELS) as Array<keyof typeof RETENTION_LABELS>).map(
          (k) => [k, RETENTION_LABELS[k]],
        )}
        value={retention}
        display={(v) => v.replace(/d$/, "")}
        onPick={(v) => void pick(v as ReceiptRetention)}
        own={{
          label: `Your own number of days, 1 to ${MAX_RETENTION_DAYS}`,
          placeholder: `Or your own: 1 to ${MAX_RETENTION_DAYS} days`,
          parse: (t) => {
            const n = parseWholeNumber(t, 1, MAX_RETENTION_DAYS);
            return n === null
              ? { error: `Pick a number of days from 1 to ${MAX_RETENTION_DAYS}.` }
              : { value: `${n}d` };
          },
        }}
      />
      {count > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDone(null);
            setAsk({ kind: "all", n: count });
          }}
        >
          <span style={{ color: "var(--c-danger)" }}>Delete all receipt photos</span>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled>
          No photos to delete
        </Button>
      )}
      {done && <p role="status">{done}</p>}
      <Sheet
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={
          ask?.kind === "shorten" ? "Delete older receipt photos?" : "Delete all receipt photos?"
        }
      >
        {ask && (
          <>
            <p>
              {ask.kind === "all"
                ? `This removes ${photos(ask.n)} from this phone, for good.`
                : `This deletes ${photos(ask.n)} older than ${retentionLabel(ask.retention).toLowerCase()}, for good.`}
            </p>
            <p>
              We don't keep a copy, and they aren't in your backup, so there's no way to get them
              back.
            </p>
            <p>Your entries and amounts stay.</p>
            {/* Keep them comes first, so the sheet opens with focus on the safe choice */}
            <Button variant="secondary" block onClick={() => setAsk(null)}>
              Keep them
            </Button>
            <Button variant="danger" block onClick={() => void confirm()}>
              Delete {photos(ask.n)}
            </Button>
          </>
        )}
      </Sheet>
    </Card>
  );
}
