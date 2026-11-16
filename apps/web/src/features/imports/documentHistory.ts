import { useLiveQuery } from "dexie-react-hooks";
import { useDb } from "../../data/DbProvider.tsx";
import { daysUntil } from "../../engine/bridge.ts";
import { maskFileName } from "../../importers/masking.ts";
import { dayOf, formatCents, formatDate, formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import { kindLabel, STALE_DAYS } from "../networth/useNetWorth.ts";

/** One file added: a statement imported, or a document whose total went to Net worth. */
export interface DocRow {
  id: string;
  /** The file's name, masked as it was kept. */
  name: string;
  /** The date or dates the document gives. */
  when: string;
  added: string;
  became: string;
  /** Days since a total's date, when it is past the update nudge. */
  oldDays: number | null;
}

/**
 * Every file added on this device, newest first (November 16, 2026): what Your documents lists
 * and what the import screen shows as "Added before". Read from the device only.
 */
export function useDocumentHistory(): DocRow[] | undefined {
  const { db } = useDb();
  const today = todayIso();
  return useLiveQuery(async (): Promise<DocRow[]> => {
    const [statements, totals, accounts] = await Promise.all([
      db.statement_imports.toArray(),
      db.document_imports.toArray(),
      db.accounts.toArray(),
    ]);
    const account = new Map(accounts.map((a) => [a.id, a]));
    const out: Array<DocRow & { at: string }> = [];
    for (const s of statements) {
      const a = account.get(s.account_id);
      const where = a ? `${a.label}${a.last4 ? ` ••${a.last4}` : ""}` : "An account removed since";
      out.push({
        id: `statement:${s.id}`,
        at: s.created_at,
        name: maskFileName(s.file_name),
        when:
          s.period_start && s.period_end
            ? `${formatDate(s.period_start)} – ${formatDate(s.period_end)}`
            : s.period_end
              ? `To ${formatDate(s.period_end)}`
              : "Dates not given",
        added: formatDay(dayOf(s.created_at)),
        became: `${where} · ${s.rows_added} ${s.rows_added === 1 ? "transaction" : "transactions"}`,
        oldDays: null,
      });
    }
    for (const d of totals) {
      // Whole days from the document's date to today (dates.days_until).
      const age = d.as_of ? await daysUntil(d.as_of, today) : null;
      out.push({
        id: `document:${d.id}`,
        at: d.created_at,
        name: maskFileName(d.file_name),
        when: d.as_of ? formatDate(d.as_of) : "Date not given",
        added: formatDay(dayOf(d.created_at)),
        became: `Net worth · ${d.label} · ${formatCents(d.cents)}${d.kind === "debt" ? " owed" : ""} · ${kindLabel(d.group, d.own_kind)}`,
        oldDays: age !== null && age > STALE_DAYS ? age : null,
      });
    }
    return out
      .sort((a, b) => compareText(b.at, a.at) || compareText(a.id, b.id))
      .map(({ at: _at, ...r }) => r);
  }, [db, today]);
}
