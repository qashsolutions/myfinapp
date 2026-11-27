import { expect, type Page, test } from "@playwright/test";
import { readyAccount } from "../e2e/helpers.ts";
import {
  appFetch,
  backFromStripe,
  CARDS,
  cancelConsent,
  lapsedAccount,
  payByCard,
  toCheckout,
} from "./pay.ts";
import {
  advanceClock,
  billing,
  clockNow,
  clockSubscription,
  customerOf,
  DAY,
  deleteClock,
  newClock,
  quote,
  sql,
  stripe,
  unblock,
  userIdOf,
  waitForPlan,
} from "./stripe.ts";

/**
 * Connected paid for through Stripe test mode, with a bank linked through the fake Plaid the
 * e2e API runs (tests/e2e_app.py; start-api.sh serves it here too): what a person paying for
 * linking gets, and what happens to their banks when the plan is cancelled, ends, is
 * switched down, is bought again as Private, or the account is deleted (hard constraint 3:
 * Free and Private never link).
 */

const BANK = "First Platypus Bank";

let clock = "";
let blockedEmail = "";
test.afterEach(async () => {
  if (clock) await deleteClock(clock);
  // A fraud warning blocks the test card; lift only that, so a rerun can pay with it.
  if (blockedEmail) await unblock(blockedEmail);
  clock = "";
  blockedEmail = "";
});

/** Plaid's Hosted Link page, answered here: the person links the bank and is sent back. */
async function hostedLink(page: Page) {
  await page.route("https://hosted.plaid.example/**", (route) => {
    const back = new URL(route.request().url()).searchParams.get("return") ?? "/";
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><title>Plaid (test)</title><a href="${back}">Continue to Qash</a>`,
    });
  });
}

/** A passkey check, when the app asks for one (the virtual authenticator answers). */
async function confirmIfAsked(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await sheet.isVisible().catch(() => false)) {
    await sheet.getByRole("button").first().click();
    await expect(sheet).toBeHidden();
  }
}

/** Linked banks → Connect → Plaid → back: the bank is linked and its first sync arrives. */
async function linkBank(page: Page) {
  await hostedLink(page);
  await page.goto("/me/linking");
  await page.getByRole("button", { name: "Connect a bank or card" }).click();
  await confirmIfAsked(page);
  await page.getByRole("link", { name: "Continue to Qash" }).click();
  await expect(page.getByText(`${BANK} is linked.`)).toBeVisible();
  await expect(page.getByText(/^Transactions: 3 new\./)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(BANK)).toBeVisible();
}

function connections(email: string): string {
  return sql(`SELECT count(*) FROM bank_connections c JOIN users u ON u.id = c.user_id
              WHERE u.email = ${quote(email)}`);
}

async function connectionId(page: Page): Promise<string> {
  const r = await page.request.get("/api/linking");
  const list = (await r.json()).connections as Array<{ id: string }>;
  return list[0]?.id ?? "";
}

async function syncStatus(page: Page, id: string): Promise<{ status: number; detail: unknown }> {
  return appFetch(page, `/api/linking/${id}/sync`, { cursor: null });
}

test("L1 Connected paid by card: a bank links, reads, and cancelling keeps it to the paid end", async ({
  page,
}) => {
  const responses: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/linking")) responses.push(await r.text().catch(() => ""));
  });
  const email = await lapsedAccount(page, "l1");
  // Lapsed: Linked banks offers no Connect until a plan that links is paid for.
  expect((await appFetch(page, "/api/linking/start", {})).status).toBe(403);

  await toCheckout(page, "Connected", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  expect(charges.data?.map((c) => c.amount)).toEqual([700]);

  await linkBank(page);
  await page.goto("/money?view=transactions");
  await expect(page.getByText(/PLATYPUS COFFEE/i).first()).toBeVisible();

  // Cancel on the Plan screen: the box must be ticked, then it reads Ending.
  await page.goto("/me/plan");
  await page.getByRole("button", { name: "Cancel plan" }).click();
  const sheet = page.getByRole("dialog", { name: "If you cancel" });
  await sheet.getByRole("button", { name: "Cancel plan" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Tick the box above to cancel.");
  await expect(sheet.getByRole("checkbox")).toBeFocused();
  await sheet.getByRole("checkbox").check();
  await sheet.getByRole("button", { name: "Cancel plan" }).click();
  await confirmIfAsked(page);
  await expect(page.getByText("Ending", { exact: true })).toBeVisible();
  const b = await billing(page);
  expect(b.plan).toBe("connected");
  const sub = (await stripe("GET", "/subscriptions", { customer: customerOf(email) })).data?.[0];
  expect(sub?.cancel_at_period_end).toBe(true);

  // The month is paid for: the bank still reads until it ends.
  const id = await connectionId(page);
  expect((await syncStatus(page, id)).status).toBe(200);
  // Plaid's access token never reaches the device.
  for (const body of responses) expect(body).not.toContain("access-sandbox");
});

test("L2 a cancelled Connected plan ends: the bank stops being read, and paying again reads it", async ({
  page,
}) => {
  const email = await readyAccount(page, "l2", "Connected");
  await linkBank(page);
  const id = await connectionId(page);
  sql(`UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE email = ${quote(email)}`);
  clock = await newClock();
  await clockSubscription(email, "connected", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "connected" && b.status === "active", "Connected");
  expect(
    (await appFetch(page, "/api/billing/cancel", { consent: await cancelConsent(page) })).status,
  ).toBe(200);
  await advanceClock(clock, (await clockNow(clock)) + 32 * DAY);
  await waitForPlan(page, (b) => b.status === "canceled", "Stripe to end it", 90_000);
  // The clock ended it in its own time, a month ahead of ours: let that month pass here too.
  sql(`UPDATE subscriptions SET ends_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  await waitForPlan(page, (b) => b.plan !== "connected", "the plan to end");

  // Ended: nothing is read from the bank, and nothing new can be linked.
  expect(await syncStatus(page, id)).toEqual({ status: 403, detail: "plan_required" });
  expect((await appFetch(page, `/api/linking/${id}/cards`, {})).status).toBe(403);
  expect((await appFetch(page, "/api/linking/start", {})).status).toBe(403);
  expect(connections(email)).toBe("1"); // kept, so coming back needs no new link

  // Back on Connected: the same connection reads again.
  await toCheckout(page, "Connected", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected again");
  expect((await syncStatus(page, id)).status).toBe(200);
});

test("L3 switching down to Private disconnects the banks at Plaid; the entries stay", async ({
  page,
}) => {
  const email = await readyAccount(page, "l3", "Connected");
  await linkBank(page);
  sql(`UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE email = ${quote(email)}`);
  clock = await newClock();
  await clockSubscription(email, "connected", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "connected" && b.status === "active", "Connected");
  sql(`UPDATE subscriptions SET created_at = now() - interval '31 days', plan_changed_at = NULL
       WHERE user_id = (SELECT id FROM users WHERE email = ${quote(email)})`);
  const preview = await page.evaluate(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await fetch("/api/billing/change/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "private", interval: "monthly", tz }),
    });
    return { body: await r.json(), tz };
  });
  // The sheet says the banks go before anything happens.
  expect(JSON.stringify(preview.body.consent.lines)).toMatch(/bank/i);
  const shown = preview.body.consent;
  const r = await appFetch(page, "/api/billing/change", {
    plan: "private",
    interval: "monthly",
    proration_date: preview.body.proration_date,
    consent: { ...shown, tz: preview.tz, accepted: true },
  });
  expect(r.status).toBe(200);
  expect(connections(email)).toBe("0");
  await page.goto("/me/linking");
  await expect(page.getByText("Linking banks and cards comes with Connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect a bank or card" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Check for new transactions" })).toBeHidden();
  await page.goto("/money?view=transactions");
  await expect(page.getByText(/PLATYPUS COFFEE/i).first()).toBeVisible();
});

test("L4 a Connected trial with a bank, then Private bought: Private never links", async ({
  page,
}) => {
  const email = await readyAccount(page, "l4", "Connected");
  await linkBank(page);
  sql(`UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE email = ${quote(email)}`);
  // Said before the payment page opens (invariant 98), and only because there is a bank.
  await page.goto("/me/plan");
  await page.getByRole("radio", { name: /Monthly/ }).check();
  await page
    .getByRole("article", { name: "Private" })
    .getByRole("button", { name: /Choose/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "Before you subscribe" });
  await expect(
    sheet.getByText(
      "Private doesn't link banks: yours are disconnected now. Accounts and entries stay.",
    ),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  // Hard constraint 3: Private never links, so the trial's bank goes as a switch down's does.
  await expect.poll(() => connections(email), { timeout: 30_000 }).toBe("0");
  await page.goto("/me/linking");
  await expect(page.getByText("Linking banks and cards comes with Connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for new transactions" })).toBeHidden();
  await page.goto("/money?view=transactions");
  await expect(page.getByText(/PLATYPUS COFFEE/i).first()).toBeVisible();
});

test("L5 Private paid by card: linking is refused everywhere and the screen says why", async ({
  page,
}) => {
  await lapsedAccount(page, "l5");
  await page.goto("/me/plan");
  await page.getByRole("radio", { name: /Monthly/ }).check();
  await page
    .getByRole("article", { name: "Private" })
    .getByRole("button", { name: /Choose/ })
    .click();
  const sheet = page.getByRole("dialog", { name: "Before you subscribe" });
  await expect(sheet.getByText(/^\$3\.00 today/)).toBeVisible();
  await expect(sheet.getByText(/doesn't link banks/)).toHaveCount(0); // no bank, no line
  await page.keyboard.press("Escape");
  await toCheckout(page, "Private", "Monthly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  // A plan with no connections answers as a full one would (check_limit with a cap of 0).
  expect(await appFetch(page, "/api/linking/start", {})).toEqual({
    status: 403,
    detail: "plan_limit",
  });
  await page.goto("/me/linking");
  await expect(page.getByText("Linking banks and cards comes with Connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect a bank or card" })).toBeHidden();
});

test("L6 upgrading Private → Connected opens linking at once", async ({ page }) => {
  const email = await lapsedAccount(page, "l6");
  clock = await newClock();
  await clockSubscription(email, "private", "monthly", { clock });
  await waitForPlan(page, (b) => b.plan === "private", "Private");
  expect((await appFetch(page, "/api/linking/start", {})).status).toBe(403);
  const preview = await page.evaluate(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await fetch("/api/billing/change/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "connected", interval: "monthly", tz }),
    });
    return { body: await r.json(), tz };
  });
  const r = await appFetch(page, "/api/billing/change", {
    plan: "connected",
    interval: "monthly",
    proration_date: preview.body.proration_date,
    consent: { ...preview.body.consent, tz: preview.tz, accepted: true },
  });
  expect(r.status).toBe(200);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  await linkBank(page);
  expect(connections(email)).toBe("1");
});

test("L7 deleting a Connected account with a bank linked revokes it and refunds what it showed", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "l7");
  await toCheckout(page, "Connected", "Yearly");
  await payByCard(page, CARDS.ok);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected");
  await linkBank(page);
  const customer = customerOf(email);
  const userId = userIdOf(email);
  const credit = await page.request.get("/api/billing/credit");
  const promised = (await credit.json()).refund_if_deleted_cents as number;
  expect((await appFetch(page, "/api/account/delete", { confirm: "DELETE" })).status).toBe(204);
  // Revoked at Plaid and gone from the server at the deletion, not at the purge.
  expect(sql(`SELECT count(*) FROM bank_connections WHERE user_id = ${quote(userId)}`)).toBe("0");
  await expect
    .poll(
      async () => {
        const list = await stripe("GET", "/charges", { customer });
        return (list.data ?? []).reduce((n, c) => n + Number(c.amount_refunded ?? 0), 0);
      },
      { timeout: 60_000 },
    )
    .toBe(promised);
});

test("L8 an early fraud warning on Connected: refunded, the plan ends, the bank is not read", async ({
  page,
}) => {
  const email = await lapsedAccount(page, "l8");
  blockedEmail = email;
  await toCheckout(page, "Connected", "Monthly");
  await payByCard(page, CARDS.fraudWarning);
  await backFromStripe(page);
  await waitForPlan(page, (b) => b.plan === "connected", "Connected", 90_000).catch(() => null);
  if ((await billing(page)).plan === "connected") await linkBank(page);
  const row = () =>
    sql(`SELECT s.status FROM subscriptions s JOIN users u ON u.id = s.user_id
         WHERE u.email = ${quote(email)}`);
  await expect.poll(row, { timeout: 150_000 }).toBe("canceled");
  const id = await connectionId(page);
  if (id) expect((await syncStatus(page, id)).status).toBe(403);
  expect((await appFetch(page, "/api/linking/start", {})).status).toBe(403);
});

test("L9 a Connected trial ends with a bank linked: the locked app still lets it be disconnected", async ({
  page,
}) => {
  const email = await readyAccount(page, "l9", "Connected");
  await linkBank(page);
  sql(`UPDATE users SET trial_ends_at = now() - interval '1 hour' WHERE email = ${quote(email)}`);
  await page.goto("/budget");
  await expect(page).toHaveURL(/\/me\/plan/); // locked to the plan, export and delete
  // Invariant 97: whoever holds a connection can always drop it.
  await page.goto("/me/linking");
  await expect(page.getByRole("heading", { level: 1, name: "Linked banks & cards" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check for new transactions" })).toBeHidden();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page
    .getByRole("dialog", { name: `Disconnect ${BANK}?` })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(
    page.getByText(`${BANK} is disconnected. Its accounts and entries stay on this device.`),
  ).toBeVisible();
  expect(connections(email)).toBe("0");
});
