import { Card, List, ListRow } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents, formatDateTime } from "../../lib/format.ts";
import { APP_NAME, showHandle } from "./payLinks.ts";

/** Me → Payments I confirmed (spec "Before you pay"): every Check first, kept on this device. */
export function PaymentsConfirmed() {
  const { db } = useDb();
  const rows = useLiveQuery(() => db.split_payments.orderBy("at").reverse().toArray(), [db]);
  return (
    <>
      <ScreenHeader title="Payments I confirmed" actions={null} back="/me" />
      {rows && rows.length === 0 ? (
        <Card>
          <p>Nothing yet. Each time you tick both boxes before paying someone, it's kept here.</p>
        </Card>
      ) : (
        <List card aria-label="Payments I confirmed">
          {(rows ?? []).map((p) => (
            <ListRow
              key={p.id}
              label={`${p.to_name} · ${formatCents(p.cents)}`}
              sublabel={`${formatDateTime(p.at)} · ${APP_NAME[p.app]} ${showHandle(p.app, p.handle)} · I know them · I checked the bills`}
            />
          ))}
        </List>
      )}
      <p className="auth__fineprint">
        On this device, in your backup and your export. Qash's server keeps only that you saw the
        warning, and when.
      </p>
    </>
  );
}
