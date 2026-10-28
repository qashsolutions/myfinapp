/**
 * The fake server's consent wording (tests only). The real lines are built and checked by
 * services/api/app/services/consent_text.py (tests/test_consent_text.py pins them); the app
 * only shows what the server sends and sends it back (October 28, 2026). This copy lets the
 * fake answer the same way for the fixtures, and refuse anything else like the server does.
 */

import type { components } from "@stackd/api-client";
import { formatCents, formatDate } from "../src/lib/format.ts";

type ConsentText = components["schemas"]["ConsentTextOut"];
type Point = ConsentText["points"][number];
type Interval = "monthly" | "yearly";

export const FAKE_CONSENT_VERSION = "2026-10-24";

const PRICES = {
  private: { monthly: 300, yearly: 2000 },
  connected: { monthly: 700, yearly: 6500 },
} as const;
const NAMES = { private: "Private", connected: "Connected" } as const;
const PAY_WITH =
  "A credit or debit card issued by a US bank (Visa, Mastercard, Amex, Discover), or a US bank account. Paid through Stripe; we never see your card or bank details. A bank payment takes up to 4 business days to clear, and the plan starts when it does.";

function text(points: Point[], agreement: string): ConsentText {
  return {
    version: FAKE_CONSENT_VERSION,
    points,
    lines: points.map((p) => (p.head ? `${p.head}: ${p.text}` : p.text)),
    agreement,
  };
}

function agreement(plan: string, interval: Interval | null): string {
  if (plan === "founding")
    return "I understand this is one payment for the whole term, and it doesn't renew.";
  return interval === "yearly"
    ? "I understand my plan renews every year until I cancel, cancelling refunds nothing, and deleting my account early charges the months used at the monthly price."
    : "I understand my plan renews every month until I cancel.";
}

function refund(plan: keyof typeof PRICES, interval: Interval): Point {
  return interval === "yearly"
    ? {
        icon: "refund",
        text: `Delete your account early: the months used, this one included, cost the monthly price (${formatCents(PRICES[plan].monthly)}); the rest of the year comes back, less Stripe's fee.`,
      }
    : {
        icon: "refund",
        text: "Delete your account: we keep this month; any credit comes back, less Stripe's fee.",
      };
}

export function purchaseConsent(
  plan: "private" | "connected" | "founding",
  interval: Interval | null,
  trialEndsAt: string | null,
): ConsentText {
  if (plan === "founding")
    return text(
      [
        { icon: "price", text: "$150.00 today, once. No renewal." },
        { icon: "term", text: "4 years of Connected, every feature." },
        { icon: "cancel", text: "Before it ends, you pick a plan. Nothing is deleted." },
        {
          icon: "refund",
          text: "Delete your account: we keep this month and refund the rest, less Stripe's fee.",
        },
        { icon: "card", text: PAY_WITH },
      ],
      agreement(plan, null),
    );
  const iv = interval ?? "monthly";
  const per = iv === "yearly" ? "year" : "month";
  const price = formatCents(PRICES[plan][iv]);
  const trial =
    trialEndsAt && new Date(trialEndsAt).getTime() - Date.now() >= 49 * 3_600_000
      ? formatDate(trialEndsAt)
      : null;
  const points: Point[] = [
    {
      icon: "price",
      text: trial
        ? `Free until ${trial}, then ${price} every ${per}.`
        : `${price} today, then every ${per}.`,
    },
    { icon: "renew", text: `Renews automatically each ${per} until you cancel.` },
  ];
  if (iv === "yearly")
    points.push(
      {
        icon: "term",
        text: `Yearly costs less than 12 monthly payments (${formatCents(12 * PRICES[plan].monthly)}) only if you stay the year.`,
      },
      {
        icon: "cancel",
        text: "Cancel any time in Me → Plan. It runs to the end of the paid year; nothing is refunded.",
      },
    );
  else
    points.push({
      icon: "cancel",
      text: "Cancel any time in Me → Plan. It runs to the month's end.",
    });
  points.push(
    {
      icon: "renew",
      text: "Switch up any time for the difference. Switch down from 30 days in; the rest becomes credit.",
    },
    refund(plan, iv),
    { icon: "card", text: PAY_WITH },
  );
  return text(points, agreement(plan, iv));
}

export function changeConsent(
  plan: "private" | "connected",
  interval: Interval,
  preview: { kind: string; due_now_cents: number; credit_after_cents: number },
  disconnects: boolean,
  currentLabel: string,
): ConsentText {
  const per = interval === "yearly" ? "year" : "month";
  const name = NAMES[plan];
  const points: Point[] =
    preview.kind === "up"
      ? [
          {
            icon: "price",
            text: `${formatCents(preview.due_now_cents)} today: ${name} less what's left of ${currentLabel}.`,
          },
          {
            icon: "term",
            text: `${name} · ${interval} starts now. Switching down again opens in 30 days.`,
          },
        ]
      : [
          {
            icon: "price",
            text:
              preview.credit_after_cents > 0
                ? `Nothing today. ${formatCents(preview.credit_after_cents)} credit pays your next bills.`
                : "Nothing is charged today.",
          },
          { icon: "term", text: `${name} · ${interval} starts now.` },
        ];
  if (disconnects)
    points.push({
      icon: "unlink",
      text: `${name} doesn't link banks: yours are disconnected now. Accounts and entries stay.`,
    });
  points.push(
    {
      icon: "renew",
      text: `Then ${formatCents(PRICES[plan][interval])} every ${per} until you cancel.`,
    },
    refund(plan, interval),
  );
  return text(points, agreement(plan, interval));
}

export function cancelConsent(
  label: string,
  renewsAt: string | null,
  refundCents: number,
): ConsentText {
  const until = renewsAt ? formatDate(renewsAt) : "the paid period ends";
  const points: Point[] = [
    { head: "Stays on", text: `${label} runs until ${until}.` },
    { head: "No charges", text: "Nothing more is billed after that." },
    { head: "7-day grace", text: "Then subscribe again or download your data." },
    { head: "Then deleted", text: "Account and data go; leftover credit is refunded." },
  ];
  if (refundCents > 0)
    points.push({
      head: "Want money back?",
      text: `Delete your account instead: ${formatCents(refundCents)} back.`,
    });
  return text(points, "I have read and understood these terms.");
}

/** The server's check: the lines and box sent back must be the ones it built. */
export function sameConsent(sent: unknown, expected: ConsentText): boolean {
  const c = sent as { version?: string; lines?: string[]; agreement?: string } | undefined;
  return (
    c?.version === expected.version &&
    JSON.stringify(c.lines) === JSON.stringify(expected.lines) &&
    c.agreement === expected.agreement
  );
}
