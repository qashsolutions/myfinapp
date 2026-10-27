/**
 * The plan and the two Stripe doors (docs/spec.md "Plans & billing"): hosted Checkout to buy
 * and the Customer Portal for receipts and the card on file. Switching plans and cancelling
 * happen here, through the server (October 17, 2026: every switch is at once; an upgrade is
 * charged the difference, a downgrade leaves the unused part as credit for the next bills, and
 * deleting the account refunds what is left). The server builds both Stripe
 * sessions; this device only follows the URL. Card details never pass through here.
 */

import type { components } from "@stackd/api-client";
import { useCallback, useEffect, useState } from "react";
import { type ApiFailure, api, failureOf } from "../../data/api.ts";
import { formatCents, formatDate } from "../../lib/format.ts";
import { describeLimits, parseEntitlements } from "./entitlements.ts";

export type BillingOut = components["schemas"]["BillingOut"];
export type ChangePreview = components["schemas"]["ChangePreviewOut"];
export type Credit = components["schemas"]["CreditOut"];
export type CheckoutPlan = "private" | "connected" | "founding";
export type Interval = "monthly" | "yearly";

/** Where the last Checkout or Portal hand-off went (tests; jsdom cannot navigate). */
export const billingState: { lastUrl: string | null } = { lastUrl: null };

export function goExternal(url: string): void {
  billingState.lastUrl = url;
  try {
    window.location.assign(url);
  } catch {
    // jsdom
  }
}

export async function fetchBilling(): Promise<BillingOut | ApiFailure> {
  const r = await api.GET("/api/billing");
  return failureOf(r) ?? (r.data as BillingOut);
}

/** The "Before you subscribe" wording version; the server refuses any other (409). Bump it
 * with services/api/app/routers/billing.py CONSENT_VERSION when the wording changes. */
export const CONSENT_VERSION = "2026-10-24";

export interface Consent {
  lines: string[];
  agreement: string;
}

export async function startCheckout(
  plan: CheckoutPlan,
  interval: Interval | null,
  consent: Consent,
): Promise<ApiFailure | null> {
  const r = await api.POST("/api/billing/checkout", {
    body: {
      plan,
      interval: plan === "founding" ? null : interval,
      consent: { version: CONSENT_VERSION, ...consent, accepted: true },
    },
  });
  const failure = failureOf(r);
  if (failure) return failure;
  goExternal((r.data as { url: string }).url);
  return null;
}

/** What switching to `plan` / `interval` charges today, or the credit it leaves. */
export async function previewChange(
  plan: "private" | "connected",
  interval: Interval,
): Promise<ChangePreview | ApiFailure> {
  const r = await api.POST("/api/billing/change/preview", { body: { plan, interval } });
  return failureOf(r) ?? (r.data as ChangePreview);
}

/** Switch plan or billing period on the live subscription, now. */
export async function changePlan(
  plan: "private" | "connected",
  interval: Interval,
  prorationDate: number | null,
  consent: Consent,
): Promise<BillingOut | ApiFailure> {
  const r = await api.POST("/api/billing/change", {
    body: {
      plan,
      interval,
      proration_date: prorationDate,
      consent: { version: CONSENT_VERSION, ...consent, accepted: true },
    },
  });
  return failureOf(r) ?? (r.data as BillingOut);
}

/** Tester tools (admins only): use `plan` for free, or `null` to go back to the real plan. */
export async function setTesterPlan(
  plan: "free" | "private" | "connected" | "founding" | null,
): Promise<BillingOut | ApiFailure> {
  const r = await api.POST("/api/billing/tester", { body: { plan } });
  return failureOf(r) ?? (r.data as BillingOut);
}

/** Credit on the account, and what deleting the account now would refund. */
export async function fetchCredit(): Promise<Credit | ApiFailure> {
  const r = await api.GET("/api/billing/credit");
  return failureOf(r) ?? (r.data as Credit);
}

export async function openPortal(): Promise<ApiFailure | null> {
  const r = await api.POST("/api/billing/portal");
  const failure = failureOf(r);
  if (failure) return failure;
  goExternal((r.data as { url: string }).url);
  return null;
}

/**
 * Stop renewal (cancel) or undo that (resume). The plan stays on until the end of the period
 * already paid for; the server talks to Stripe (owner decision, October 13, 2026). Cancelling
 * sends the ticked "I have read and understood" with the lines shown (October 18, 2026).
 */
export async function changeRenewal(
  cancel: { lines: string[]; agreement: string } | null,
): Promise<BillingOut | ApiFailure> {
  const r = cancel
    ? await api.POST("/api/billing/cancel", {
        body: { consent: { version: CONSENT_VERSION, ...cancel, accepted: true } },
      })
    : await api.POST("/api/billing/resume");
  return failureOf(r) ?? (r.data as BillingOut);
}

/** One Plan history row (owner decision, October 18, 2026). */
export type PlanEvent = components["schemas"]["PlanEventOut"];

/** Plan history, newest first. */
export async function fetchHistory(): Promise<PlanEvent[] | ApiFailure> {
  const r = await api.GET("/api/billing/history");
  return failureOf(r) ?? (r.data as PlanEvent[]);
}

export function isFailure(value: unknown): value is ApiFailure {
  return !!value && typeof value === "object" && "status" in value && "code" in value;
}

export function useBilling(): {
  billing: BillingOut | null;
  error: ApiFailure | null;
  refresh: () => Promise<void>;
} {
  const [billing, setBilling] = useState<BillingOut | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const refresh = useCallback(async () => {
    const result = await fetchBilling();
    if (isFailure(result)) setError(result);
    else {
      setError(null);
      setBilling(result);
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void fetchBilling().then((result) => {
      if (!alive) return;
      if (isFailure(result)) setError(result);
      else setBilling(result);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { billing, error, refresh };
}

/** The Me row's second line: "Renews Oct 9, 2027 · $20.00", or the limits on Free. */
export function summaryLine(b: BillingOut): string {
  const access = parseEntitlements(b.entitlements)?.access;
  if (access?.state === "trial" && access.trial_ends_at)
    return `Free trial until ${formatDate(access.trial_ends_at)}`;
  if (access?.state === "lapsed" && access.delete_at)
    return `Wrapped up · open until ${formatDate(access.delete_at)}`;
  if (b.plan === "founding")
    return `Connected until ${b.ends_at ? formatDate(b.ends_at) : "the end of the term"} · ${formatCents(Number(b.founding.one_time_cents ?? 0))} once`;
  if (b.plan === "private" || b.plan === "connected") {
    const price = formatCents(
      priceCents(b, b.plan, b.interval === "monthly" ? "monthly" : "yearly"),
    );
    if (!b.renews_at) return price;
    return `${b.cancel_at_period_end ? "Ends" : "Renews"} ${formatDate(b.renews_at)} · ${price}`;
  }
  const limits = parseEntitlements(b.entitlements);
  return limits ? describeLimits(limits) : "No plan yet";
}

/** "yearly" → "$20.00 a year", "monthly" → "$3.00 a month", from the server's prices. */
export function priceCents(billing: BillingOut, plan: string, interval: Interval): number {
  const p = billing.prices[plan];
  if (!p) return 0;
  return interval === "yearly" ? p.yearly_cents : p.monthly_cents;
}
