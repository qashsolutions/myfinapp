import { Button } from "@stackd/ui";
import { useEffect, useState } from "react";
import { parseAmount, type SplitPart, splitItemize } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";

export interface ItemsResult {
  amount_cents: number;
  people: string[];
  parts: SplitPart[];
  leftover_to: string;
}

interface Row {
  key: number;
  what: string;
  amount: string;
  people: string[];
}

/**
 * "By item" (chunk S.8, November 10, 2026): each item with who shared it, then tax, tip and
 * fees, which follow each person's items (`splits.itemize`). The bill is saved as each person's
 * exact part; the items are how it was worked out.
 */
export function BillItems({
  everyone,
  nameOf,
  leftoverTo,
  onResult,
}: {
  everyone: string[];
  nameOf: (id: string) => string;
  /** Who takes a leftover cent when they shared in it (else the item's first person). */
  leftoverTo: string;
  onResult: (r: ItemsResult | { problem: string } | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([{ key: 1, what: "", amount: "", people: [] }]);
  const [extras, setExtras] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  // The people's ids, not the array: the screen rebuilds that array on every render.
  const everyoneKey = everyone.join(",");

  useEffect(() => {
    const people = everyoneKey.split(",");
    let alive = true;
    void (async () => {
      const filled = rows.filter((r) => r.amount.trim() || r.people.length);
      if (filled.length === 0) {
        setTotal(null);
        onResult(null);
        return;
      }
      const items: Array<{ cents: number; people: string[] }> = [];
      for (const r of filled) {
        let cents: number;
        try {
          cents = await parseAmount(r.amount);
        } catch {
          if (alive) onResult({ problem: "invalid_amount" });
          return;
        }
        if (cents <= 0) return alive ? onResult({ problem: "invalid_amount" }) : undefined;
        if (r.people.length === 0)
          return alive ? onResult({ problem: "item_no_people" }) : undefined;
        items.push({ cents, people: people.filter((p) => r.people.includes(p)) });
      }
      let extrasCents = 0;
      if (extras.trim()) {
        try {
          extrasCents = await parseAmount(extras);
        } catch {
          if (alive) onResult({ problem: "invalid_amount" });
          return;
        }
      }
      const inAny = people.filter((p) => items.some((i) => i.people.includes(p)));
      const lt = inAny.includes(leftoverTo) ? leftoverTo : (inAny[0] ?? leftoverTo);
      try {
        const r = await splitItemize(items, extrasCents, lt);
        if (!alive) return;
        setTotal(r.total_cents);
        onResult({
          amount_cents: r.total_cents,
          people: r.parts.map((p) => p.person),
          parts: r.parts,
          leftover_to: lt,
        });
      } catch (e) {
        if (alive) onResult({ problem: (e as { code?: string }).code ?? "invalid_amount" });
      }
    })();
    return () => {
      alive = false;
    };
  }, [rows, extras, everyoneKey, leftoverTo, onResult]);

  const set = (key: number, change: Partial<Row>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...change } : r)));

  return (
    <fieldset className="split-people">
      <legend className="auth__label">Items</legend>
      {rows.map((r, i) => (
        <div className="split-item" key={r.key}>
          <div className="split-item__head">
            <span className="split-item__title">Item {i + 1}</span>
            {rows.length > 1 ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove item ${i + 1}`}
                onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <div className="split-person">
            <input
              className="auth__input"
              aria-label={`Item ${i + 1}, what`}
              placeholder="Pasta"
              value={r.what}
              maxLength={40}
              onChange={(e) => set(r.key, { what: e.target.value })}
            />
            <span className="split-value">
              <span className="split-value__unit" aria-hidden="true">
                $
              </span>
              <input
                className="auth__input"
                inputMode="decimal"
                aria-label={`Item ${i + 1}, amount`}
                placeholder="18.00"
                value={r.amount}
                onChange={(e) => set(r.key, { amount: e.target.value })}
              />
            </span>
          </div>
          <fieldset className="kind-chips split-item__who" aria-label={`Item ${i + 1}, who had it`}>
            <legend className="split-item__who-label">Who had it?</legend>
            {everyone.map((p) => (
              <label className="chip-option" key={p}>
                <input
                  className="segmented__input"
                  type="checkbox"
                  checked={r.people.includes(p)}
                  onChange={(e) =>
                    set(r.key, {
                      people: e.target.checked ? [...r.people, p] : r.people.filter((x) => x !== p),
                    })
                  }
                />
                {nameOf(p)}
              </label>
            ))}
          </fieldset>
        </div>
      ))}
      <Button
        variant="secondary"
        block
        className="split-item__add"
        onClick={() =>
          setRows((list) => [
            ...list,
            { key: (list.at(-1)?.key ?? 0) + 1, what: "", amount: "", people: [] },
          ])
        }
      >
        + Add another item
      </Button>
      <label className="auth__field">
        <span className="auth__label">Tax, tip and fees</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="0.00"
          value={extras}
          onChange={(e) => setExtras(e.target.value)}
        />
      </label>
      <p className="auth__hint">
        Tax, tip and fees are shared by what each person had.
        {total !== null ? ` Total ${formatCents(total)}.` : ""}
      </p>
    </fieldset>
  );
}
