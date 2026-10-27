import { Link } from "react-router";
import { formatDate } from "../../lib/format.ts";
import { useEntitlements } from "./entitlements.ts";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Home's trial countdown (owner decision, October 14, 2026): days left in the free trial on a
 * ring; from the day the server names (`card_from`: day 40 of Private, day 5 of Connected) it
 * asks for a card, which is first charged when the trial ends.
 */
export function TrialCard({ now = new Date() }: { now?: Date }) {
  const { entitlements, known } = useEntitlements();
  const access = known ? entitlements.access : null;
  if (access?.state !== "trial" || !access.trial_ends_at) return null;
  const ends = new Date(access.trial_ends_at);
  const left = Math.max(0, Math.ceil((ends.getTime() - now.getTime()) / DAY));
  const total = access.days ?? left;
  const askCard = access.card_from ? now >= new Date(access.card_from) : false;
  const name = access.plan === "connected" ? "Connected" : "Private";
  const fraction = total ? Math.min(1, Math.max(0, left / total)) : 0;
  return (
    <div className={`trial-card${askCard ? " trial-card--ask" : ""}`}>
      <svg className="trial-card__ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="18" className="trial-card__track" />
        <circle
          cx="22"
          cy="22"
          r="18"
          className="trial-card__fill"
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={100 - fraction * 100}
        />
        <text x="22" y="26" textAnchor="middle" className="trial-card__n">
          {left}
        </text>
      </svg>
      <div className="trial-card__text">
        <p className="trial-card__title">
          {name} trial · {left} {left === 1 ? "day" : "days"} left
        </p>
        <p className="trial-card__sub">
          {askCard
            ? `Add a card to keep everything. Nothing is charged until ${formatDate(access.trial_ends_at)}.`
            : `Free until ${formatDate(access.trial_ends_at)}. No card needed yet.`}
        </p>
      </div>
      <Link to="/me/plan" className={askCard ? "trial-card__cta" : "trial-card__link"}>
        {askCard ? "Add a card" : "Plans"}
      </Link>
    </div>
  );
}
