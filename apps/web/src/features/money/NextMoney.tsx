import { buttonClass, Card } from "@stackd/ui";
import { Link } from "react-router";
import { formatCents } from "../../lib/format.ts";
import { FORECAST_DAYS, useForecast } from "../forecast/useForecast.ts";

/**
 * Money in & out's forward view (owner decision, October 25, 2026): the next 30 days from the
 * forecast's own numbers: expected income, bills, and usual spending (typical daily × 30), with
 * what would be kept. An estimate from the person's history, like the forecast it comes from.
 */
export function NextMoney({ today }: { today: string }) {
  const view = useForecast(today);
  if (view.loading || !view.daily || !view.upcoming)
    return <p className="range-note">Adding it up…</p>;
  const open = view.upcoming.items.filter((i) => !i.matched);
  const income = open.filter((i) => i.kind === "income").reduce((t, i) => t + i.amount_cents, 0);
  const bills = open.filter((i) => i.kind === "bill").reduce((t, i) => t + i.amount_cents, 0);
  const usual = view.daily.cents_per_day * FORECAST_DAYS;
  const out = bills + usual;
  const kept = income - out;
  if (income === 0 && out === 0)
    return (
      <Card as="section" aria-label="Start">
        <h2 className="forecast__status-word">Start</h2>
        <p>Add your pay and your bills, and the next 30 days fill in here.</p>
        <Link to="/bills" className={buttonClass({ variant: "secondary", block: true })}>
          Add pay and bills
        </Link>
      </Card>
    );
  return (
    <>
      <Card
        as="section"
        aria-label={kept >= 0 ? "Saving" : "Over"}
        className={kept >= 0 ? "forecast__status--ok" : "forecast__warn"}
      >
        <h2 className="forecast__status-word">{kept >= 0 ? "Saving" : "Over"}</h2>
        <p>
          {kept >= 0
            ? `About ${formatCents(kept)} kept over the next 30 days, after bills and usual spending.`
            : `About ${formatCents(-kept)} more out than in over the next 30 days.`}
        </p>
      </Card>
      <fieldset className="stats">
        <legend className="sr-only">The next 30 days</legend>
        <div className="stat">
          <span className="stat__l">In</span>
          <span className="stat__n stat__n--good">{formatCents(income, "in")}</span>
        </div>
        <div className="stat">
          <span className="stat__l">Out</span>
          <span className="stat__n stat__n--out">{formatCents(out, "out")}</span>
        </div>
        <div className="stat stat--kept">
          <span className="stat__l">Kept</span>
          <span className={`stat__n${kept < 0 ? " stat__n--bad" : ""}`}>{formatCents(kept)}</span>
        </div>
      </fieldset>
      <p className="range-note">
        Out is {formatCents(bills)} in bills plus {formatCents(usual)} of usual spending (
        {formatCents(view.daily.cents_per_day)} a day). An estimate from your own history.
      </p>
      <Link to="/forecast" className={buttonClass({ variant: "secondary", block: true })}>
        See it day by day
      </Link>
    </>
  );
}
