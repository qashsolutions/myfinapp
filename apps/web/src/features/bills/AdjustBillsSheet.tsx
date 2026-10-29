import { Button, Sheet } from "@stackd/ui";
import { useDb } from "../../data/DbProvider.tsx";
import { byLabel } from "../../lib/order.ts";
import { useLookups } from "../entries/useEntries.ts";
import {
  DEFAULT_EVERYDAY,
  saveRegularCategories,
  useRegularPrefs,
} from "../forecast/useRecurring.ts";

/**
 * "Adjust bills" (owner decision, October 29, 2026; invariant 52): which of the person's spending
 * categories count as everyday. A weekly or every-2-weeks run mostly in one of them is regular
 * spending, not a bill. The defaults are config/insights.yaml's; their own categories are here
 * too. Saved in `settings` `bills.regular_categories` (on this device and in backups).
 */
export function AdjustBillsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { db } = useDb();
  const lookups = useLookups();
  const prefs = useRegularPrefs();
  const categories = [...(lookups?.categories.values() ?? [])]
    .filter((c) => c.kind === "expense" && !c.hidden)
    .sort((a, b) => byLabel(a.name, b.name));
  const chosen = prefs?.categories ?? new Set(DEFAULT_EVERYDAY);

  async function toggle(id: string) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    await saveRegularCategories(
      db,
      categories.map((c) => c.id).filter((c) => next.has(c)),
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Adjust bills">
      <fieldset className="bills-adjust">
        <legend>Everyday categories</legend>
        <p className="auth__hint">
          Something paid every week or two in these is regular spending, not a bill.
        </p>
        <div className="bills-everyday">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`sk-chip ${chosen.has(c.id) ? "sk-chip--accent" : "sk-chip--neutral"}`}
              aria-pressed={chosen.has(c.id)}
              onClick={() => void toggle(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="auth__hint">
        Your own call on one merchant always wins. Monthly bills stay bills. Kept on this device and
        in your backups.
      </p>
      <Button
        block
        variant="secondary"
        onClick={() => void saveRegularCategories(db, [...DEFAULT_EVERYDAY])}
      >
        Back to Groceries, Dining, Transport, Shopping
      </Button>
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}
