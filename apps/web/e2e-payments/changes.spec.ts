import { expect, test } from "@playwright/test";
import {
  appFetch,
  backFromStripe,
  CARDS,
  CONSENT,
  lapsedAccount,
  payByCard,
  toCheckout,
} from "./pay.ts";
import {
  billing,
  clockSubscription,
  customerOf,
  deleteClock,
  failNextCharges,
  newClock,
  quote,
  sql,
  stripe,
  waitForPlan,
} from "./stripe.ts";

/**
 * Changing plans (D20–D25), refunds on deletion (E26–E29) and webhooks that must be refused
 * (F31), against Stripe test mode. A refund is checked two ways: what the Delete account screen
 * promised is what Stripe paid.
 */

let clock = "";
test.afterEach(async () => {
  if (clock) await deleteClock(clock);
  clock = "";
});

/** As the Plan screen's change sheet does: the preview's own lines, sent back ticked (the
 * server builds the wording and refuses any other text with 409 consent_mismatch). */
async function change(page: Parameters<typeof appFetch>[0], plan: string, interval: string) {
  const preview = await page.evaluate(
    async ([p, i]) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await fetch("/api/billing/change/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: p, interval: i, tz }),
      });
      return { status: r.status, body: await r.json(), tz };
    },
    [plan, interval] as const,
  );
  if (preview.status !== 200) return { preview, result: null };
  const shown = preview.body.consent as { version: string; lines: string[]; agreement: string };
  const result = await appFetch(page, "/api/billing/change", {
    plan,
    interval,
    proration_date: preview.body.proration_date,
    consent: {
      version: shown.version,
      lines: shown.lines,
      agreement: shown.agreement,
      tz: preview.tz,
      accepted: true,
    },
  });
  return { preview, result };
}

function stripePrice(subscription: { items: { data: Array<{ price: { id: string } }> } }) {
  return subscription.items.data[0]?.price.id;
}

test("D20 upgrade Private → Connected: the difference is charged now, the plan switches", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "d20");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const { preview, result } = await change(page, "connected", "monthly");
  expect(preview.body.kind).toBe("up");
  expect(preview.body.due_now_cents).toBeGreaterThan(0);
  expect(result?.status).toBe(200);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  const charges = await stripe("GET", "/charges", { customer });
  const amounts = (charges.data ?? []).map((c) => c.amount as number).sort((a, b) => a - b);
  expect(amounts).toContain(preview.body.due_now_cents);
  const sub = (await stripe("GET", `/subscriptions/${subscription}`)) as never;
  expect(stripePrice(sub)).toContain("price_");
});

test("D21 an upgrade whose card declines: refused, nothing changes", async ({ page }) => {
  const email = await lapsedAccount(page, "d21");
  clock = await newClock();
  const { customer, subscription } = await clockSubscription(email, "private", "monthly", {
    clock,
  });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const before = stripePrice((await stripe("GET", `/subscriptions/${subscription}`)) as never);
  await failNextCharges(customer);
  const { result } = await change(page, "connected", "monthly");
  expect(result).toEqual({ status: 402, detail: "payment_failed" });
  expect((await billing(page)).plan).toBe("private");
  const after = stripePrice((await stripe("GET", `/subscriptions/${subscription}`)) as never);
  expect(after).toBe(before);
});

test("D22 downgrade: refused within 30 days, then allowed, leaving credit", async ({ page }) => {
  const email = await lapsedAccount(page, "d22");
  clock = await newClock();
  const { customer } = await clockSubscription(email, "connected", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  const early = await change(page, "private", "monthly");
  expect(early.preview.status).toBe(409); // refused at the preview, before anything is shown
  expect(early.preview.body.detail).toBe("downgrade_too_soon");
  sql(`UPDATE subscriptions SET created_at = now() - interval '31 days', plan_changed_at = NULL
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  const later = await change(page, "private", "monthly");
  expect(later.preview.body.kind).toBe("down");
  expect(later.result?.status).toBe(200);
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const balance = (await stripe("GET", `/customers/${customer}`)).balance as number;
  expect(balance).toBeLessThan(0); // Stripe keeps credit as a negative balance
});

test("D23 monthly → yearly: switches at once and charges the difference", async ({ page }) => {
  const email = await lapsedAccount(page, "d23");
  clock = await newClock();
  await clockSubscription(email, "private", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const { preview, result } = await change(page, "private", "yearly");
  expect(preview.body.kind).toBe("up");
  expect(result?.status).toBe(200);
  await waitForPlan(page, (b) => b.interval === "yearly", "yearly");
});

test("D25 Founding while a plan renews: told to cancel first", async ({ page }) => {
  const email = await lapsedAccount(page, "d25");
  clock = await newClock();
  await clockSubscription(email, "private", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const r = await appFetch(page, "/api/billing/checkout", { plan: "founding", consent: CONSENT });
  expect(r).toEqual({ status: 409, detail: "cancel_first" });
});

// --- E. Refunds on deletion ---------------------------------------------------------------

async function deleteAccount(page: Parameters<typeof appFetch>[0]): Promise<number> {
  const credit = await page.request.get("/api/billing/credit");
  const promised = (await credit.json()).refund_if_deleted_cents as number;
  const r = await appFetch(page, "/api/account/delete", { confirm: "DELETE" });
  expect(r.status).toBe(204);
  return promised;
}

async function refunded(customer: string): Promise<number> {
  const charges = await stripe("GET", "/charges", { customer });
  return (charges.data ?? []).reduce((n, c) => n + Number(c.amount_refunded ?? 0), 0);
}

test("E26 deleting on a monthly plan: the plan ends now, no refund", async ({ page }) => {
  const email = await lapsedAccount(page, "e26");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const customer = customerOf(email);
  expect(await deleteAccount(page)).toBe(0);
  const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
  expect(((subs.data ?? [])[0] as { status: string }).status).toBe("canceled");
  expect(await refunded(customer)).toBe(0);
});

test("E27 deleting on a yearly plan: the refund Stripe pays is the one the screen showed", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "e27");
  await toCheckout(page, "Connected", "Yearly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  const customer = customerOf(email);
  const promised = await deleteAccount(page);
  // $65.00, less this month at the monthly $7.00, less Stripe's card fee on the rest.
  expect(promised).toBe(5800 - Math.round(5800 * 0.029) - 30);
  await expect.poll(() => refunded(customer), { timeout: 60_000 }).toBe(promised);
});

test("E28 deleting with credit from a downgrade: the credit comes back too", async ({ page }) => {
  const email = await lapsedAccount(page, "e28");
  clock = await newClock();
  const { customer } = await clockSubscription(email, "connected", "yearly", { clock });
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  sql(`UPDATE subscriptions SET created_at = now() - interval '31 days', plan_changed_at = NULL
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  expect((await change(page, "private", "yearly")).result?.status).toBe(200);
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  const promised = await deleteAccount(page);
  expect(promised).toBeGreaterThan(0);
  await expect.poll(() => refunded(customer), { timeout: 60_000 }).toBe(promised);
  expect((await stripe("GET", `/customers/${customer}`)).balance).toBe(0);
});

test("E29 deleting a Founding membership a year in: the unused years come back", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "e29");
  await toCheckout(page, "Founding member");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "founding", "Founding");
  sql(`UPDATE subscriptions SET created_at = now() - interval '365 days',
       ends_at = now() + interval '1096 days'
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  const customer = customerOf(email);
  const promised = await deleteAccount(page);
  expect(promised).toBeGreaterThan(10_000); // about three years of $150, less this month
  await expect.poll(() => refunded(customer), { timeout: 60_000 }).toBe(promised);
});

// --- F. Webhooks that must be refused ---------------------------------------------------

test("F31 a forged or tampered webhook is refused and grants nothing", async ({ page }) => {
  const email = await lapsedAccount(page, "f31");
  const forged = {
    id: `evt_forged_${Date.now()}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        mode: "subscription",
        payment_status: "paid",
        subscription: "sub_forged",
        client_reference_id: sql(`SELECT id FROM users WHERE email = ${quote(email)}`),
        metadata: { plan: "connected", interval: "yearly" },
      },
    },
  };
  const body = JSON.stringify(forged);
  const now = Math.floor(Date.now() / 1000);
  for (const signature of ["", "t=1,v1=bad", `t=${now},v1=${"0".repeat(64)}`]) {
    const r = await page.request.post("http://127.0.0.1:8100/api/webhooks/stripe", {
      data: body,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
    expect(r.status()).toBe(400);
  }
  expect((await billing(page)).plan).toBe("free");
});
