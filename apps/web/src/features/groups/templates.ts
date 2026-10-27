/**
 * Challenge types (fast-follow 4; docs/spec.md "Goals & challenges": the monthly savings
 * challenge plus No-Eat-Out Week, Dining diet, No-spend weekend and 52-week saving). Each
 * member's own goal is built from the template on their device; the group only ever sees a
 * percentage. The ranking stays "% of your own target": savings and 52-week by money saved,
 * the week and the weekend by days checked in, the dining diet by the amount kept back.
 */

import type { GoalKind } from "../../data/db.ts";

export type TemplateKey =
  | "monthly_savings"
  | "no_eat_out_week"
  | "dining_diet"
  | "no_spend_weekend"
  | "fifty_two_week";

export interface ChallengeTemplate {
  key: TemplateKey;
  title: string;
  kind: GoalKind;
  /** "month" uses the calendar month; the others take a start date. */
  span: "month" | "week" | "weekend" | "year";
  blurb: string;
  points: [string, string, string];
  /** Money templates: a target per member; habits: days; dining diet: amount to keep back. */
  targetPresets: number[];
  habitDays: number | null;
  habitLabel: string | null;
  categoryName: string | null;
}

export const FIFTY_TWO_WEEK_TOTAL = 137800; // $1 + $2 + … + $52, the classic sum (proposed default)

export const TEMPLATES: ChallengeTemplate[] = [
  {
    key: "monthly_savings",
    title: "Monthly savings",
    kind: "save",
    span: "month",
    blurb: "Everyone saves toward their own target this month.",
    points: [
      "Everyone saves toward their own target",
      "Ranked by % of your own target",
      "Log deposits here; your money stays where it is",
    ],
    targetPresets: [10000, 25000, 50000, 100000],
    habitDays: null,
    habitLabel: null,
    categoryName: null,
  },
  {
    key: "no_eat_out_week",
    title: "No-Eat-Out Week",
    kind: "habit",
    span: "week",
    blurb: "Seven days of cooking at home. Check in each day you manage it.",
    points: [
      "One check-in a day for seven days",
      "Ranked by % of days checked in",
      "No amounts involved; just the streak",
    ],
    targetPresets: [],
    habitDays: 7,
    habitLabel: "no eating out",
    categoryName: null,
  },
  {
    key: "dining_diet",
    title: "Dining diet",
    kind: "spend_less",
    span: "month",
    blurb: "Spend less on dining this month than you usually do.",
    points: [
      "You say what you usually spend on dining and how much to keep back",
      "Ranked by % of your own amount kept back, from your entries",
      "Your spending stays on your device",
    ],
    targetPresets: [5000, 10000, 15000, 20000],
    habitDays: null,
    habitLabel: null,
    categoryName: "Dining",
  },
  {
    key: "no_spend_weekend",
    title: "No-spend weekend",
    kind: "habit",
    span: "weekend",
    blurb: "Saturday and Sunday with nothing bought. Check in each day.",
    points: [
      "One check-in a day for two days",
      "Ranked by % of days checked in",
      "No amounts involved",
    ],
    targetPresets: [],
    habitDays: 2,
    habitLabel: "no spending",
    categoryName: null,
  },
  {
    key: "fifty_two_week",
    title: "52-week saving",
    kind: "save",
    span: "year",
    blurb: "A year of weekly deposits toward your own total; the classic is $1,378.",
    points: [
      "Everyone saves toward their own total over 52 weeks",
      "Ranked by % of your own total",
      "Log deposits here; your money stays where it is",
    ],
    targetPresets: [FIFTY_TWO_WEEK_TOTAL, 50000, 100000, 260000],
    habitDays: null,
    habitLabel: null,
    categoryName: null,
  },
];

export function templateOf(key: string | null | undefined): ChallengeTemplate {
  return TEMPLATES.find((t) => t.key === key) ?? (TEMPLATES[0] as ChallengeTemplate);
}

/** The next Saturday on or after `today` (YYYY-MM-DD), for the weekend template. */
export function nextSaturday(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  const ahead = (6 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}
