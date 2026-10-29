import "../auth/auth.css";

import { Button, Sheet, Toggle } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { bankName } from "../linking/anchorText.ts";
import { aprText } from "./DebtList.tsx";
import { type CardInPlan, cardName, pairDebt, saveCardChoice } from "./debtPlan.ts";

/** The person's own APR or minimum, checked; null when the box is empty. */
export async function readOwnRate(
  apr: string,
  minimum: string,
): Promise<{ apr_bps: number | null; min_payment_cents: number | null } | string> {
  try {
    const aprBps = apr.trim() ? await parseAmount(apr) : null; // "27.99" % -> 2799 bps
    const min = minimum.trim() ? await parseAmount(minimum) : null;
    if ((aprBps !== null && aprBps < 0) || (min !== null && min < 0))
      return "Amounts can't be negative.";
    if (aprBps !== null && aprBps > 100_00) return "An APR is between 0 and 100%.";
    return { apr_bps: aprBps, min_payment_cents: min };
  } catch {
    return "Enter an APR like 27.99 and a minimum like 35.";
  }
}

/**
 * A linked card in the payoff plan (invariant 65): what the bank sent, the APR or minimum the
 * person gives when the issuer sent none, whether it counts in the plan, and which hand-added
 * debt (if any) is this same card so it counts once.
 */
export function CardDebtSheet({
  card,
  unpaired,
  onClose,
}: {
  card: CardInPlan | null;
  unpaired: { id: string; label: string }[];
  onClose: () => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const [apr, setApr] = useState("");
  const [minimum, setMinimum] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Filled when a card opens, not on every live update while it is open.
  const openFor = card?.account.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when another card opens
  useEffect(() => {
    if (!card) return;
    setApr(
      card.apr_from === "yours" && card.apr_bps !== null ? (card.apr_bps / 100).toFixed(2) : "",
    );
    setMinimum(
      card.min_from === "yours" && card.min_payment_cents !== null
        ? (card.min_payment_cents / 100).toFixed(2)
        : "",
    );
    setError(null);
  }, [openFor]);

  if (!card) return null;
  const account = card.account;
  const askApr = card.apr_from !== "issuer";
  const askMin = card.min_from !== "issuer";
  const pairOptions: Array<[string, string]> = [
    ["", "No, a different debt"],
    ...(card.paired ? [[card.paired.id, card.paired.label] as [string, string]] : []),
    ...unpaired.map((d) => [d.id, d.label] as [string, string]),
  ];

  async function save() {
    setError(null);
    const read = await readOwnRate(askApr ? apr : "", askMin ? minimum : "");
    if (typeof read === "string") {
      setError(read);
      return;
    }
    await saveCardChoice(db, account.id, {
      ...(askApr ? { apr_bps: read.apr_bps } : {}),
      ...(askMin ? { min_payment_cents: read.min_payment_cents } : {}),
    });
    onClose();
  }

  return (
    <Sheet open onClose={onClose} title={cardName(account)}>
      <p className="auth__hint">
        From {bankName(account)}, read-only.{" "}
        {card.owed_cents !== null ? `Owed now ${formatCents(card.owed_cents)}.` : ""}
        {card.apr_from === "issuer" && card.apr_bps !== null
          ? ` ${aprText(card.apr_bps)} from the issuer.`
          : ""}
        {card.min_from === "issuer" && card.min_payment_cents !== null
          ? ` Minimum ${formatCents(card.min_payment_cents)}.`
          : ""}
      </p>
      {askApr ? (
        <label className="auth__field">
          <span className="auth__label">APR % (the issuer didn't send it)</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="27.99"
            value={apr}
            onChange={(e) => setApr(e.target.value)}
          />
        </label>
      ) : null}
      {askMin ? (
        <label className="auth__field">
          <span className="auth__label">Minimum payment (the issuer didn't send it)</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="35"
            value={minimum}
            onChange={(e) => setMinimum(e.target.value)}
          />
        </label>
      ) : null}
      {pairOptions.length > 1 ? (
        <>
          <p className="auth__label">Did you also add this card by hand?</p>
          <ChoiceChips
            name={`${ids}-pair`}
            options={pairOptions}
            value={card.paired?.id ?? ""}
            onPick={(v) => {
              if (v) void pairDebt(db, v, account.id);
              else if (card.paired) void pairDebt(db, card.paired.id, null);
            }}
          />
          <p className="auth__fineprint">Pick it and it counts once, at the bank's balance.</p>
        </>
      ) : null}
      <Toggle
        label="Count in the payoff plan"
        checked={!card.left_out}
        onChange={(on) => void saveCardChoice(db, account.id, { left_out: !on })}
      />
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {askApr || askMin ? (
        <Button block onClick={save}>
          Save
        </Button>
      ) : (
        <Button block variant="secondary" onClick={onClose}>
          Done
        </Button>
      )}
    </Sheet>
  );
}
