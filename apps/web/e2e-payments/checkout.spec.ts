import { expect, test } from "@playwright/test";
import { readyAccount } from "../e2e/helpers.ts";
import {
  answer3ds,
  appFetch,
  backFromStripe,
  CARDS,
  CONSENT,
  lapsedAccount,
  payByBank,
  payByCard,
  stripeSays,
  toCheckout,
} from "./pay.ts";
import {
  billing,
  blockedFor,
  customerOf,
  quote,
  setTrialEnd,
  sql,
  stripe,
  subjectsTo,
  unblock,
  waitForPlan,
} from "./stripe.ts";

/**
 * Buying (plan A1–A11): the real Plan screen, Stripe's real hosted page in test mode, real
 * webhooks. Each test checks what the person sees, the plan the server grants and what
 * Stripe holds.
 */

test("A1 a card pays for Private monthly: the plan starts and Stripe charged $3.00", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "a1");
  await toCheckout(page, "Private", "Monthly");
  await expect(page.getByText("$3.00")).toBeVisible();
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  const b = await waitForPlan(page, (x) => x.plan === "private", "Private");
  expect(b.interval).toBe("monthly");
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  expect(charges.data?.map((c) => c.amount)).toEqual([300]);
  // The consent was stored before Stripe opened.
  expect(
    sql(`SELECT count(*) FROM purchase_consents c JOIN users u ON u.id = c.user_id
         WHERE u.email = ${quote(email)} AND c.terms_version = '2026-10-24'`),
  ).toBe("1");
});

test("A1 a card pays for Connected yearly at $65.00", async ({ page }) => {
  const email = await lapsedAccount(page, "a1y");
  await toCheckout(page, "Connected", "Yearly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (x) => x.plan === "connected" && x.interval === "yearly", "Connected");
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  expect(charges.data?.map((c) => c.amount)).toEqual([6500]);
});

for (const [name, card, says] of [
  ["declined", CARDS.declined, /declined/i],
  ["insufficient funds", CARDS.insufficient, /insufficient funds|declined/i],
  ["expired", CARDS.expired, /expired/i],
  ["wrong CVC", CARDS.badCvc, /security code|CVC/i],
] as const) {
  test(`A5 a ${name} card: Stripe says so, no plan, nothing charged`, async ({ page }) => {
    const email = await lapsedAccount(page, `a5-${name.replace(/ /g, "").toLowerCase()}`);
    await toCheckout(page, "Private", "Monthly");
    await payByCard(page, card);
    await stripeSays(page, says);
    await page.goto("/me/plan");
    expect((await billing(page)).plan).toBe("free");
    expect(customerOf(email)).toBe("");
  });
}

test("A2 Founding by card: four years of Connected, no renewal, one place fewer", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "a2");
  await page.goto("/me/plan");
  const before = (await billing(page)).founding.left;
  await toCheckout(page, "Founding member");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  const b = await waitForPlan(page, (x) => x.plan === "founding", "Founding");
  expect(b.interval).toBeNull();
  expect(b.founding.left).toBe(before - 1);
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  expect(charges.data?.map((c) => c.amount)).toEqual([15000]);
});

test("A3 during the trial: the card is saved now and charged only when the trial ends", async ({
  page,
}) => {
  const email = await readyAccount(page, "a3"); // a fresh 3-day trial
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (x) => x.plan === "private", "Private");
  const customer = customerOf(email);
  expect((await stripe("GET", "/charges", { customer })).data).toEqual([]);
  const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
  const sub = subs.data?.[0] as { status: string; trial_end: number };
  expect(sub.status).toBe("trialing");
  const trialEnd = Number(
    sql(`SELECT extract(epoch FROM trial_ends_at)::int FROM users WHERE email = ${quote(email)}`),
  );
  expect(Math.abs(sub.trial_end - trialEnd)).toBeLessThan(120);
});

// Owner decision, October 28, 2026: nothing is charged until the trial ends, even under
// Stripe's 48-hour trial_end minimum. There the checkout anchors the billing cycle on the
// trial end with proration_behavior none (stripe_billing.checkout_session). Not yet run against
// Stripe test mode: run it before merging, and check the $0 first invoice and the saved card.
test("A3b late in the trial (30 hours left): $0 today, the first charge on the trial end", async ({
  page,
}) => {
  const email = await readyAccount(page, "a3b");
  setTrialEnd(email, "30 hours");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (x) => x.plan === "private", "Private");
  const customer = customerOf(email);
  const charges = (await stripe("GET", "/charges", { customer })).data ?? [];
  expect(charges.filter((c) => Number(c.amount) > 0)).toEqual([]);
  // Stripe makes no invoice at all before a future billing date with no proration: nothing paid.
  const invoices = await stripe("GET", "/invoices", { customer });
  expect((invoices.data ?? []).filter((i) => Number(i.amount_paid) > 0)).toEqual([]);
  const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
  const sub = subs.data?.[0] as { billing_cycle_anchor: number; default_payment_method: unknown };
  const trialEnd = Number(
    sql(`SELECT extract(epoch FROM trial_ends_at)::int FROM users WHERE email = ${quote(email)}`),
  );
  expect(Math.abs(sub.billing_cycle_anchor - trialEnd)).toBeLessThan(120);
  // The card was kept for the first real charge on the trial-end day.
  expect(sub.default_payment_method).toBeTruthy();
});

// Every Stripe test card that triggers 3-D Secure is issued outside the US, so with the
// US-only Radar rule on, "a US card passes the check and pays" can't run in test mode. These
// check what does happen: the bank's check is shown, and a non-US card is refused either way.
for (const answer of ["Complete", "Fail"] as const) {
  test(`A6 a non-US card the bank checks: refused even when the check is ${answer === "Complete" ? "passed" : "failed"}`, async ({
    page,
  }) => {
    const email = await lapsedAccount(page, `a6${answer.toLowerCase()}`);
    await toCheckout(page, "Private", "Monthly");
    await payByCard(page, CARDS.threeDs);
    await answer3ds(page, answer);
    await stripeSays(page, /declined|unable to authenticate/i);
    expect((await billing(page)).plan).toBe("free");
    const customer = customerOf(email);
    if (customer) {
      const charges = await stripe("GET", "/charges", { customer });
      expect((charges.data ?? []).filter((c) => c.status === "succeeded")).toEqual([]);
    }
  });
}

test("A7 a card issued outside the US is refused", async ({ page }) => {
  await lapsedAccount(page, "a7");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.brazil);
  await stripeSays(page, /declined|not supported|can't be used/i);
  expect((await billing(page)).plan).toBe("free");
});

test("A8 leaving Stripe's page: back on the Plan screen, nothing charged", async ({ page }) => {
  const email = await lapsedAccount(page, "a8");
  await toCheckout(page, "Private", "Monthly");
  await page.getByRole("link", { name: /Back to Qash/ }).click();
  await page.waitForURL(/\/me\/plan\?checkout=cancel/);
  expect((await billing(page)).plan).toBe("free");
  expect(customerOf(email)).toBe("");
});

test("A9 a Founding page expires after about 30 minutes, and an expired one takes nothing", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "a9");
  await toCheckout(page, "Founding member");
  const id = page.url().match(/cs_test_[A-Za-z0-9]+/)?.[0] as string;
  const session = (await stripe("GET", `/checkout/sessions/${id}`)) as {
    created: number;
    expires_at: number;
  };
  const minutes = (session.expires_at - session.created) / 60;
  expect(minutes).toBeGreaterThan(30);
  expect(minutes).toBeLessThanOrEqual(31.1);
  await stripe("POST", `/checkout/sessions/${id}/expire`);
  await page.reload();
  await expect(page.getByText(/timed out|expired/i).first()).toBeVisible();
  await page.goto("/me/plan");
  expect((await billing(page)).plan).toBe("free");
  expect(customerOf(email)).toBe("");
});

test("A10 + A11 already paid, stale consent, no fresh passkey: each refused before Stripe", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "a10");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (x) => x.plan === "private", "Private");
  const again = await appFetch(page, "/api/billing/checkout", {
    plan: "connected",
    interval: "monthly",
    consent: CONSENT,
  });
  expect(again).toEqual({ status: 409, detail: "already_subscribed" });
  // A fresh account for the consent and passkey checks.
  const old = await appFetch(page, "/api/billing/checkout", {
    plan: "founding",
    consent: { ...CONSENT, version: "2026-10-22" },
  });
  expect(old.status).toBe(409);
  sql(`UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes'
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  const stale = await appFetch(page, "/api/billing/checkout", {
    plan: "founding",
    consent: CONSENT,
  });
  expect(stale).toEqual({ status: 403, detail: "step_up_required" });
});

// --- B. US bank accounts ---------------------------------------------------------------------

test("B12 a US bank account that clears: 'on its way', then the plan starts", async ({ page }) => {
  const email = await lapsedAccount(page, "b12");
  await toCheckout(page, "Private", "Monthly");
  await payByBank(page, "Success ••••6789");
  await backFromStripe(page);
  const b = await waitForPlan(page, (x) => x.plan === "private", "bank payment to clear", 240_000);
  expect(b.payment_pending).toBe(false);
  // It went through the "clearing" step: the plan waited for the bank, not Stripe's "active".
  expect(
    sql(`SELECT s.first_payment FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE u.email = ${quote(email)}`),
  ).toBe("paid");
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  const method = ((charges.data ?? [])[0] as { payment_method_details: { type: string } })
    .payment_method_details.type;
  expect(method).toBe("us_bank_account");
});

test("B13 a US bank account that fails: no plan, and the person is told", async ({ page }) => {
  const email = await lapsedAccount(page, "b13");
  await toCheckout(page, "Private", "Monthly");
  await payByBank(page, "Failure ••••1116");
  await backFromStripe(page);
  const until = Date.now() + 240_000;
  while (Date.now() < until && !subjectsTo(email).includes("Your bank payment didn't go through"))
    await page.waitForTimeout(2000);
  expect(subjectsTo(email)).toContain("Your bank payment didn't go through");
  expect((await billing(page)).plan).toBe("free");
  // Ended at Stripe, so the debit is never retried.
  const subs = await stripe("GET", "/subscriptions", {
    customer: customerOf(email),
    status: "all",
  });
  expect(((subs.data ?? [])[0] as { status: string }).status).toBe("canceled");
});

// --- G. Disputes -------------------------------------------------------------------------------

// A lost dispute or a fraud-warning refund puts the test card on Stripe's test-mode block list;
// taken off after each test (a hook runs even when the test times out) so reruns can pay.
let blockedEmail = "";
test.afterEach(async () => {
  if (blockedEmail) await unblock(blockedEmail).catch(() => undefined);
  blockedEmail = "";
});

async function disputeOf(email: string): Promise<string> {
  const customer = customerOf(email);
  for (let i = 0; i < 40; i++) {
    const charges = await stripe("GET", "/charges", { customer });
    const pi = (charges.data?.[0] as { payment_intent?: string } | undefined)?.payment_intent;
    if (pi) {
      const d = await stripe("GET", "/disputes", { payment_intent: pi });
      if (d.data?.[0]?.id) return d.data[0].id as string;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("no dispute appeared");
}

for (const [outcome, evidence] of [
  ["won", "winning_evidence"],
  ["lost", "losing_evidence"],
] as const) {
  test(`G34 a disputed card payment pauses the plan; ${outcome}, it ${outcome === "won" ? "comes back" : "stays off and stops renewing"}`, async ({
    page,
  }) => {
    const email = await lapsedAccount(page, `g34${outcome}`);
    blockedEmail = email;
    await toCheckout(page, "Private", "Monthly");
    await payByCard(page, CARDS.dispute);
    await backFromStripe(page);
    await waitForPlan(page, (x) => x.entitlements.access?.state === "paused", "paused", 120_000);
    expect(subjectsTo(email)).toContain("Your Qash plan is paused while a payment is disputed");
    expect(subjectsTo("e2e-owner@example.com")).toContain("A Qash payment was disputed");
    const dispute = await disputeOf(email);
    await stripe("POST", `/disputes/${dispute}`, {
      "evidence[uncategorized_text]": evidence,
      submit: "true",
    });
    if (outcome === "won") {
      await waitForPlan(page, (x) => x.plan === "private", "the plan back", 180_000);
      expect(subjectsTo(email)).toContain("Your Qash plan is back");
    } else {
      const customer = customerOf(email);
      const until = Date.now() + 180_000;
      let status = "";
      while (Date.now() < until && status !== "canceled") {
        const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
        status = String((subs.data?.[0] as { status?: string })?.status);
        await page.waitForTimeout(3000);
      }
      expect(status).toBe("canceled");
      expect((await billing(page)).plan).toBe("free");
      // They kept the money: the inbox and the card can't buy again.
      await expect
        .poll(async () => (await blockedFor(email)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const again = await appFetch(page, "/api/billing/checkout", {
        plan: "private",
        interval: "monthly",
        consent: CONSENT,
      });
      expect(again).toEqual({ status: 403, detail: "purchase_blocked" });
    }
  });
}

test("G35 an early fraud warning: refunded in full, the plan ends, and it can't buy again", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "g35");
  blockedEmail = email;
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.fraudWarning);
  await backFromStripe(page);
  // The warning can land before the plan has even shown as started, so wait on the row.
  const row = () =>
    sql(`SELECT s.status FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE u.email = ${quote(email)}`);
  await expect.poll(row, { timeout: 150_000 }).toBe("canceled");
  expect((await billing(page)).plan).toBe("free");
  const customer = customerOf(email);
  const charge = (await stripe("GET", "/charges", { customer })).data?.[0] as {
    amount: number;
    amount_refunded: number;
  };
  expect(charge.amount_refunded).toBe(charge.amount); // in full, no fee kept
  const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
  expect(((subs.data ?? [])[0] as { status: string }).status).toBe("canceled");
  expect(subjectsTo(email)).toContain("We refunded a Qash payment and ended your plan");
  expect(subjectsTo("e2e-owner@example.com")).toContain(
    "A Qash payment was refunded on a fraud warning",
  );
  const again = await appFetch(page, "/api/billing/checkout", {
    plan: "private",
    interval: "monthly",
    consent: CONSENT,
  });
  expect(again).toEqual({ status: 403, detail: "purchase_blocked" });
  expect((await blockedFor(email)).length).toBeGreaterThan(0);
});
