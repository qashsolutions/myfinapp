import { Button, Sheet } from "@stackd/ui";
import { useDb } from "../../data/DbProvider.tsx";
import { type Category, ignoreClosed } from "../../data/db.ts";
import type { FixedFlexible, FixedOverrides } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { byLabel } from "../../lib/order.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { setOverride } from "./useFixedFlexible.ts";

const CALLS: Array<[string, string]> = [
  ["auto", "From bills"],
  ["fixed", "Fixed"],
  ["flexible", "Flexible"],
];

/**
 * Adjust fixed vs flexible (October 29, 2026; owner: customize to the person). Each expense
 * category spent in this month, or already set, can follow the bills (the automatic reading:
 * fixed when it is a bill or subscription you confirmed) or be fixed or flexible by the
 * person's own call, kept in `settings` `fixed.override` and passed to `cashflow.fixed_flexible`.
 */
export function FixedAdjustSheet({
  open,
  onClose,
  result,
  overrides,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  result: FixedFlexible | undefined;
  overrides: FixedOverrides | undefined;
  categories: Map<string, Category> | undefined;
}) {
  const { db } = useDb();
  const spent = new Map(
    (result?.by_category ?? [])
      .filter((c) => c.category_id !== null && c.out_cents !== 0)
      .map((c) => [c.category_id as string, c]),
  );
  const rows = [...(categories?.values() ?? [])]
    .filter((c) => c.kind === "expense" && (spent.has(c.id) || overrides?.[c.id] !== undefined))
    .sort((a, b) => byLabel(a.name, b.name));
  return (
    <Sheet open={open} onClose={onClose} title="Adjust fixed vs flexible">
      <p className="auth__fineprint">
        From bills: fixed when it's a bill or subscription you confirmed, flexible otherwise. Pick
        Fixed or Flexible where that reading is wrong for you.
      </p>
      {rows.length === 0 ? (
        <p>Nothing spent this month yet.</p>
      ) : (
        rows.map((c) => {
          const now = spent.get(c.id);
          return (
            <fieldset key={c.id} className="fixed-adjust__row">
              <legend className="fixed-adjust__name">{c.name}</legend>
              {now ? (
                <p className="fixed-adjust__auto">
                  This month: fixed {formatCents(now.fixed_cents)} · flexible{" "}
                  {formatCents(now.flexible_cents)}
                </p>
              ) : null}
              <ChoiceChips
                name={`fixed-call-${c.id}`}
                options={CALLS}
                value={overrides?.[c.id] ?? "auto"}
                onPick={(v) => {
                  void setOverride(db, c.id, v === "fixed" || v === "flexible" ? v : null).catch(
                    ignoreClosed,
                  );
                }}
              />
            </fieldset>
          );
        })
      )}
      <div className="install-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}
