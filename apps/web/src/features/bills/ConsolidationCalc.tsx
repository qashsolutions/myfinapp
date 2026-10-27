import "../auth/auth.css";
import "../insights/insights.css";

import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { type Consolidation, consolidation, parseAmount } from "../../engine/bridge.ts";
import { formatCents, todayIso } from "../../lib/format.ts";

function monthsText(n: number | null): string {
  if (n === null) return "never at this payment";
  return n === 1 ? "1 month" : `${n} months`;
}

/**
 * "What if I moved these balances?" (fast-follow 8): today's avalanche against one balance at
 * an offer's rates, paying the same each month. The user types the offer they are looking at;
 * the app names no lender or product and recommends nothing (spec hard constraint 6).
 */
export function ConsolidationCalc() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const debts = useLiveQuery(() => db.debts.toArray(), [db]);
  const [apr, setApr] = useState("");
  const [fee, setFee] = useState("3");
  const [promoMonths, setPromoMonths] = useState("0");
  const [promoApr, setPromoApr] = useState("0");
  const [payment, setPayment] = useState("");
  const [result, setResult] = useState<Consolidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = debts ?? [];
  const minimums = list.reduce((sum, d) => sum + d.min_payment_cents, 0);

  async function compare() {
    setError(null);
    setResult(null);
    let offer: { apr_bps: number; fee_bps: number; promo_months: number; promo_apr_bps: number };
    let paymentCents: number;
    try {
      offer = {
        apr_bps: await parseAmount(apr), // "11.99" % -> 1199 basis points
        fee_bps: await parseAmount(fee || "0"),
        promo_months: Math.max(0, Math.trunc(Number(promoMonths || "0"))),
        promo_apr_bps: await parseAmount(promoApr || "0"),
      };
      paymentCents = payment ? await parseAmount(payment) : minimums;
    } catch {
      setError("Enter rates like 11.99 and amounts like 450.00.");
      return;
    }
    if (!Number.isFinite(offer.promo_months) || offer.promo_months > 120) {
      setError("Intro months must be a whole number up to 120.");
      return;
    }
    if (paymentCents < minimums) {
      setError(`The monthly payment must cover your minimums, ${formatCents(minimums)}.`);
      return;
    }
    setResult(
      await consolidation(
        list.map((d) => ({
          id: d.id,
          label: d.label,
          balance_cents: d.balance_cents,
          apr_bps: d.apr_bps,
          min_payment_cents: d.min_payment_cents,
        })),
        offer,
        paymentCents,
        today,
      ),
    );
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    hint: string,
  ) => (
    <label className="auth__field" htmlFor={`${ids}-${id}`}>
      <span className="auth__label">{label}</span>
      <input
        id={`${ids}-${id}`}
        className="auth__input"
        inputMode="decimal"
        value={value}
        placeholder={hint}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );

  return (
    <Card as="section" aria-labelledby={`${ids}-h`}>
      <h2 className="sk-card__title" id={`${ids}-h`}>
        What if I moved these balances?
      </h2>
      <p className="auth__hint">
        Type in an offer you are looking at, a balance transfer card or a consolidation loan, and
        compare it with paying your debts as they are. The same payment each month either way.
      </p>
      {field("apr", "Rate after any intro period (APR %)", apr, setApr, "e.g. 11.99")}
      {field("fee", "Transfer or setup fee (%)", fee, setFee, "e.g. 3")}
      {field("promo-months", "Intro months (0 if none)", promoMonths, setPromoMonths, "e.g. 15")}
      {field("promo-apr", "Intro rate (APR %)", promoApr, setPromoApr, "e.g. 0")}
      {field(
        "payment",
        "Monthly payment",
        payment,
        setPayment,
        `at least ${formatCents(minimums)}`,
      )}
      <Button block onClick={compare} disabled={!apr}>
        Compare
      </Button>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div role="status" aria-label="Comparison">
          <ul className="insight__list">
            <li className="insight__row">
              <span>As they are</span>
              <strong>
                {monthsText(result.today.months)}
                {result.today.interest_cents !== null
                  ? ` · ${formatCents(result.today.interest_cents)} interest`
                  : ""}
              </strong>
            </li>
            <li className="insight__row">
              <span>
                Moved
                {result.consolidated.fee_cents > 0 ? (
                  <span className="insight__sub">
                    includes a {formatCents(result.consolidated.fee_cents)} fee
                  </span>
                ) : null}
              </span>
              <strong>
                {monthsText(result.consolidated.months)}
                {result.consolidated.cost_cents !== null
                  ? ` · ${formatCents(result.consolidated.cost_cents)} interest and fees`
                  : ""}
              </strong>
            </li>
          </ul>
          {result.saves_cents !== null ? (
            <p className="insight__safe">
              {result.saves_cents > 0
                ? `Moving would cost ${formatCents(result.saves_cents)} less.`
                : result.saves_cents < 0
                  ? `Moving would cost ${formatCents(-result.saves_cents)} more.`
                  : "About the same either way."}
            </p>
          ) : (
            <p className="insight__safe">
              At this payment the balance never clears; try a higher monthly payment.
            </p>
          )}
          {result.consolidated.balance_after_promo_cents ? (
            <p className="auth__hint">
              {formatCents(result.consolidated.balance_after_promo_cents)} would still be owed when
              the intro rate ends.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="auth__fineprint">
        An illustration from the numbers you type, not advice or an offer. Approval, rates and fees
        depend on the lender; read the terms, and a new account can affect your credit score.
      </p>
    </Card>
  );
}
