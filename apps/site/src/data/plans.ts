/**
 * Prices and limits as the site states them. The source of truth is
 * services/api/app/rules_server/plans.yaml; tests/plans.test.ts fails if these drift.
 */

export type FeatureIcon =
  | "chart"
  | "forecast"
  | "file"
  | "jar"
  | "trophy"
  | "cloud"
  | "link"
  | "heart"
  | "check";

export interface Plan {
  key: "private" | "connected";
  /** Free-trial length in days (plans.yaml `trials`; 3 days on either plan since October 22, 2026). */
  trialDays: number;
  name: string;
  tag: string | null;
  monthlyCents: number;
  yearlyCents: number;
  /** One line of value, 8 words or fewer (owner, October 14, 2026). */
  value: string;
  features: Array<{ icon: FeatureIcon; t: string }>;
  cta: string;
}

export const PLANS: Plan[] = [
  {
    key: "private",
    name: "Private",
    tag: "Most popular",
    trialDays: 3,
    monthlyCents: 300,
    yearlyCents: 2000,
    value: "Every account. Never linked. Fully private.",
    features: [
      { icon: "file", t: "Unlimited statement accounts" },
      { icon: "jar", t: "4 jars & goals" },
      { icon: "trophy", t: "Start your own challenges" },
      { icon: "cloud", t: "Encrypted backup & sync" },
      { icon: "check", t: "Statements read on your phone" },
    ],
    cta: "Start 3 days free",
  },
  {
    key: "connected",
    name: "Connected",
    tag: null,
    trialDays: 3,
    monthlyCents: 700,
    yearlyCents: 6500,
    value: "Banks and cards update themselves.",
    features: [
      { icon: "link", t: "Link 3 banks or cards, read-only" },
      { icon: "jar", t: "10 jars & goals" },
      { icon: "heart", t: "Couples & shared jars" },
      { icon: "check", t: "Everything in Private" },
    ],
    cta: "Start 3 days free",
  },
];

export const FOUNDING = {
  oneTimeCents: 15000,
  years: 4,
  cap: 250, // owner decision, October 22, 2026 (was 200): the first 250 (plans.yaml founding.cap)
};

/** Stripe's card fee taken off a refund on deletion (plans.yaml `refunds`; owner decision,
 * October 17, 2026). */
export const REFUND_FEE = { bps: 290, fixedCents: 30 };
/** A US bank account (October 24, 2026): 0.8% of the refund, never more than $5. */
export const BANK_REFUND_FEE = { bps: 80, capCents: 500 };

/** Plan limits the site states, mirrored from plans.yaml (checked by tests/plans.test.ts). */
export const LIMITS = {
  goals_active_max: { free: 2, private: 4, connected: 10 },
  statement_accounts_max: { free: 1, private: null, connected: null },
  groups_create: { free: false, private: true, connected: true },
  household: { free: false, private: false, connected: true },
  backup: { free: false, private: true, connected: true },
};

export function dollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `$${whole.toLocaleString("en-US")}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** Whole-percent saving of yearly over twelve monthly payments, for the toggle label. */
export function yearlySavingPercent(): number {
  let best = 0;
  for (const p of PLANS) {
    const twelve = p.monthlyCents * 12;
    if (twelve === 0) continue;
    best = Math.max(best, Math.round(((twelve - p.yearlyCents) * 100) / twelve));
  }
  return best;
}
