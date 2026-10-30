import type { BillingOut } from "./billing.ts";

/** Why a plan ended, from the server's `ended` (the same rule as the ended email; invariant 73). */
export type EndReason = NonNullable<BillingOut["ended"]>;

/**
 * The Plan screen's notice for a lapsed account: a headline in the ended email's own words and
 * what the person can do. `offer` is false when this inbox can't buy again.
 */
export function endNotice(
  reason: EndReason | null | undefined,
  until: string,
  shared: boolean,
): { title: string; body: string; offer: boolean } {
  const stays = `Your account stays open until ${until}; after that, what's on this device stays here until you decide.`;
  const ours = shared ? "Your shared" : "Your";
  switch (reason) {
    case "trial":
      return {
        title: `${ours} trial has wrapped up`,
        body: `Thanks for trying Qash. Pick a plan below to keep going, or download your data. ${stays}`,
        offer: true,
      };
    case "founding":
      return {
        title: `${shared ? "Your household's" : "Your"} Founding membership has ended`,
        body: `Thank you for being with Qash from the start. Pick a plan below to keep going, or download your data. ${stays}`,
        offer: true,
      };
    case "cover_ended":
      return {
        title: "Your household's plan no longer covers you",
        body: `You're no longer in a household with the person whose plan covered you both. Pick a plan of your own below, or download your data. ${stays}`,
        offer: true,
      };
    case "cover_switched":
      return {
        title: "Your household's plan no longer covers you",
        body: `The plan that covered you both changed to one without household. Pick a plan of your own below, or download your data. ${stays}`,
        offer: true,
      };
    case "holder_lost":
      return {
        title: "The plan that covered you has ended",
        body: `Pick a plan of your own below, or download your data. ${stays}`,
        offer: true,
      };
    case "payment_returned":
      return {
        title: "Your plan has ended",
        body: `We refunded the payment for your plan after your bank flagged it, so the plan has ended and a new one can't be bought on this account. Download your data any time. ${stays}`,
        offer: false,
      };
    default:
      return {
        title: `${ours} plan has wrapped up`,
        body: `Thanks for using Qash. Pick a plan below to keep going, or download your data. ${stays}`,
        offer: true,
      };
  }
}
