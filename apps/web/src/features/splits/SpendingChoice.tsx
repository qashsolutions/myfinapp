import { Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { ChipChoice } from "./ChipChoice.tsx";
import { useSplitGuest } from "./guest.ts";
import { addSettleSpending, settleDefaults } from "./settleSpending.ts";

export interface SpendingChoice {
  /** Shown only when I'm the one paying and have a budget (a guest has none). */
  active: boolean;
  on: boolean;
  setOn: (on: boolean) => void;
  categoryId: string | null;
  setCategoryId: (id: string | null) => void;
  /** After the payment is recorded: add it to my spending once, if chosen (invariant 76). */
  apply: (p: { settlementId: string; cents: number; to: string }) => Promise<void>;
}

/**
 * "Add it to my spending" (S.6): one choice for every place a payer records a payment (Mark paid
 * and Check first). On by default only with no statements and no linked accounts here.
 */
export function useSpendingChoice(groupId: string, iPay: boolean): SpendingChoice {
  const { db } = useDb();
  const guest = useSplitGuest();
  const active = iPay && !guest;
  const [on, setOn] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void settleDefaults(db, groupId).then((d) => {
      if (!alive) return;
      setOn(d.on);
      setCategoryId(d.categoryId);
    });
    return () => {
      alive = false;
    };
  }, [db, groupId, active]);
  return {
    active,
    on,
    setOn,
    categoryId,
    setCategoryId,
    apply: async ({ settlementId, cents, to }) => {
      if (active && on)
        await addSettleSpending(db, { groupId, settlementId, cents, to, categoryId });
    },
  };
}

export function SpendingChoiceFields({ choice }: { choice: SpendingChoice }) {
  const { db } = useDb();
  const categories = useLiveQuery(
    async () =>
      (await db.categories.toArray())
        .filter((c) => c.kind === "expense" && !c.hidden)
        .sort((a, b) => a.sort - b.sort),
    [db],
  );
  if (!choice.active) return null;
  return (
    <>
      <Toggle
        label="Add it to my spending"
        description="Off if your statement or linked account will show this payment, so it counts once."
        checked={choice.on}
        onChange={choice.setOn}
      />
      {choice.on && categories ? (
        <ChipChoice
          legend="Category"
          options={[
            [null, "No category"] as const,
            ...categories.map((c) => [c.id, c.name] as const),
          ]}
          value={choice.categoryId}
          onChange={(v) => choice.setCategoryId(v)}
        />
      ) : null}
    </>
  );
}
