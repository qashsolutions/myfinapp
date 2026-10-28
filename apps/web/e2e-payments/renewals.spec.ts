import { expect, test } from "@playwright/test";
import { appFetch, cancelConsent, lapsedAccount } from "./pay.ts";
import {
  advanceClock,
  billing,
  clockNow,
  clockSubscription,
  DAY,
  deleteClock,
  failNextCharges,
  newClock,
  stripe,
  waitForPlan,
} from "./stripe.ts";

/**
 * Renewals and endings (plan C15–C19) on Stripe test clocks: a month passes in seconds, and
 * Stripe sends the same webhooks it would at the real date.
 */

let clock = "";
test.afterEach(async () => {
  if (clock) await deleteClock(clock);
  clock = "";
});

async function charges(customer: string): Promise<number[]> {
  const list = await stripe("GET", "/charges", { customer });
  return (list.data ?? [])
    .filter((c) => c.status === "succeeded")
    .map((c) => c.amount as number)
    .sort();
}

async function subStatus(subscription: string): Promise<string> {
  return String((await stripe("GET", `/subscriptions/${subscription}`)).status);
}

test("C15 a monthly plan renews: charged again a month later, the plan carries on", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "c15");
  clock = await newClock();
  const { customer } = await clockSubscription(email, "private", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  await expect.poll(() => charges(customer), { timeout: 90_000 }).toEqual([300, 300]);
  const b = await billing(page);
  expect(b.plan).toBe("private");
  expect(b.status).toBe("active");
});

test("C16 a renewal whose card fails: past due while Stripe retries, then the plan ends", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "c16");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  await failNextCharges(customer);
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  await waitForPlan(page, (b) => b.status === "past_due", "past due", 90_000);
  expect((await billing(page)).plan).toBe("private"); // still working while Stripe retries
  // Stripe's retries run out within a few weeks; then it ends the subscription.
  for (let i = 0; i < 4 && !["canceled", "unpaid"].includes(await subStatus(subscription)); i++)
    await advanceClock(clock, (await clockNow(clock)) + 15 * DAY);
  expect(["canceled", "unpaid"]).toContain(await subStatus(subscription));
  // The plan ends when Stripe ended it, not at the period's end, which the failed renewal had
  // already moved a month ahead. (Test clocks run ahead of the real clock, so the comparison
  // is with Stripe's own end time rather than with "now".)
  const b = await waitForPlan(page, (x) => x.status === "canceled", "the plan to end", 90_000);
  const sub = await stripe("GET", `/subscriptions/${subscription}`);
  const stripeEnd = Number(sub.ended_at ?? sub.canceled_at);
  expect(Math.abs(Date.parse(b.ends_at as string) / 1000 - stripeEnd)).toBeLessThan(120);
  const periodEnd = Number(
    (sub.items as { data: Array<{ current_period_end: number }> }).data[0]?.current_period_end,
  );
  expect(stripeEnd).toBeLessThan(periodEnd);
});

test("C17 a failed renewal, then a new card: the plan recovers", async ({ page }) => {
  const email = await lapsedAccount(page, "c17");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  await failNextCharges(customer);
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  await waitForPlan(page, (b) => b.status === "past_due", "past due", 90_000);
  const good = await stripe("POST", "/payment_methods/pm_card_visa/attach", { customer });
  await stripe("POST", `/customers/${customer}`, {
    "invoice_settings[default_payment_method]": good.id as string,
  });
  await stripe("POST", `/subscriptions/${subscription}`, {
    default_payment_method: good.id as string,
  });
  const open = await stripe("GET", "/invoices", { subscription, status: "open" });
  await stripe("POST", `/invoices/${open.data?.[0]?.id}/pay`);
  await waitForPlan(page, (b) => b.status === "active", "active again", 90_000);
  expect((await billing(page)).plan).toBe("private");
});

test("C18 cancel: runs to the end of the paid month, then ends; nothing refunded", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "c18");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const r = await appFetch(page, "/api/billing/cancel", { consent: await cancelConsent(page) });
  expect(r.status).toBe(200);
  const sub = await stripe("GET", `/subscriptions/${subscription}`);
  expect(sub.cancel_at_period_end).toBe(true);
  expect((await billing(page)).plan).toBe("private"); // until the month ends
  const periodEnd = Number(
    (sub.items as { data: Array<{ current_period_end: number }> }).data[0]?.current_period_end,
  );
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  // It ends at the end of the month already paid for (in test-clock time).
  const b = await waitForPlan(page, (x) => x.status === "canceled", "the plan to end", 90_000);
  expect(Math.abs(Date.parse(b.ends_at as string) / 1000 - periodEnd)).toBeLessThan(120);
  expect(await charges(customer)).toEqual([300]);
  const list = await stripe("GET", "/charges", { customer });
  expect(list.data?.map((c) => c.amount_refunded)).toEqual([0]); // cancelling refunds nothing
});

test("C18 cancel then resume before the end: it renews as usual", async ({ page }) => {
  const email = await lapsedAccount(page, "c18r");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  expect(
    (await appFetch(page, "/api/billing/cancel", { consent: await cancelConsent(page) })).status,
  ).toBe(200);
  expect((await appFetch(page, "/api/billing/resume", {})).status).toBe(200);
  expect((await stripe("GET", `/subscriptions/${subscription}`)).cancel_at_period_end).toBe(false);
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  await expect.poll(() => charges(customer), { timeout: 90_000 }).toEqual([300, 300]);
  expect((await billing(page)).plan).toBe("private");
});

test("C19 a trial with a card saved: nothing charged until it ends, then the first charge", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "c19");
  clock = await newClock();
  const start = await clockNow(clock);
  const { customer } = await clockSubscription(email, "private", "monthly", {
    clock,
    trialEnd: start + 3 * DAY,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private (trialing)");
  expect(await charges(customer)).toEqual([]);
  await advanceClock(clock, start + 3 * DAY + 3600);
  await expect.poll(() => charges(customer), { timeout: 90_000 }).toEqual([300]);
  expect((await billing(page)).plan).toBe("private");
});
