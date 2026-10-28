import { expect, type Page } from "@playwright/test";
import { readyAccount } from "../e2e/helpers.ts";
import { setTrialEnd } from "./stripe.ts";

/** Stripe's published test cards (https://docs.stripe.com/testing). */
export const CARDS = {
  ok: "4242424242424242",
  declined: "4000000000000002",
  insufficient: "4000000000009995",
  expired: "4000000000000069",
  badCvc: "4000000000000127",
  // Asks the bank to authenticate (3-D Secure). Every Stripe test card that does is issued in
  // Europe (this one: Ireland), so the US-only Radar rule refuses it whatever the answer.
  threeDs: "4000002760003184",
  brazil: "4000000760000002", // issued outside the US
  dispute: "4000000000000259", // pays, then the cardholder disputes it
  fraudWarning: "4000000000005423", // pays, then the bank sends an early fraud warning
};

/** An account whose trial has just ended, so a checkout charges at once. */
export async function lapsedAccount(page: Page, tag: string): Promise<string> {
  const email = await readyAccount(page, tag);
  setTrialEnd(email, "-1 hour");
  return email;
}

/** From the Plan screen, through "Before you subscribe", to Stripe's hosted page. */
export async function toCheckout(
  page: Page,
  plan: "Private" | "Connected" | "Founding member",
  interval: "Monthly" | "Yearly" = "Monthly",
): Promise<void> {
  await page.goto("/me/plan");
  if (plan !== "Founding member") {
    await page.getByRole("radio", { name: new RegExp(interval) }).check();
  }
  const card = page.getByRole("article", { name: plan });
  await card.getByRole("button", { name: /Choose|Become/ }).click();
  const sheet = page.getByRole("dialog", { name: "Before you subscribe" });
  await sheet.getByRole("checkbox").check();
  await sheet.getByRole("button", { name: "Continue to secure payment" }).click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Payment method" })).toBeVisible();
}

/** Fill Stripe's card form and press its pay button. */
export async function payByCard(page: Page, number: string): Promise<void> {
  await page.getByTestId("card-accordion-item-button").dispatchEvent("click");
  await page.getByRole("textbox", { name: "Card number" }).fill(number);
  await page.getByRole("textbox", { name: "Expiration" }).fill("12 / 34");
  await page.getByRole("textbox", { name: "Credit or debit card CVC/CVV" }).fill("123");
  await page.getByRole("textbox", { name: "Cardholder name" }).fill("E2E Tester");
  const zip = page.getByRole("textbox", { name: "ZIP" });
  if (await zip.isVisible()) await zip.fill("94107");
  // Link's "save my information" box is ticked by default and then wants a phone number.
  const link = page.getByRole("checkbox", { name: /Save my information with Link/ });
  for (let i = 0; i < 3 && (await link.isChecked().catch(() => false)); i++) {
    await link.dispatchEvent("click");
    await page.waitForTimeout(300);
  }
  await page.getByTestId("hosted-payment-submit-button").click();
}

/** Back on the Plan screen after Stripe says the payment went through. */
export async function backFromStripe(page: Page): Promise<void> {
  await page.waitForURL(/\/me\/plan\?checkout=success/, { timeout: 90_000 });
}

/** Stripe's page shows an error and keeps the person there. */
export async function stripeSays(page: Page, text: RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 45_000 });
  expect(page.url()).toContain("checkout.stripe.com");
}

/** Stripe's test bank (Financial Connections test institution): pick an account and pay. */
export async function payByBank(
  page: Page,
  account: "Success ••••6789" | "Failure ••••1116" | "Insufficient Funds ••••2227",
): Promise<void> {
  await page.getByTestId("us_bank_account-accordion-item-button").dispatchEvent("click");
  await page.getByRole("textbox", { name: "Full name" }).fill("E2E Tester");
  await page.getByRole("button", { name: "Test (Non-OAuth)" }).click();
  const fc = page.frameLocator('iframe[src*="linked-accounts-inner"]');
  // Stripe varies what comes first between runs: a consent page, Link's sign-in ("Continue as
  // guest"), or (since October 2026) straight to choosing the account. Step through whichever
  // appear until the account list shows.
  const agree = fc.getByRole("button", { name: "Agree and continue" });
  const guest = fc.getByRole("button", { name: "Continue as guest" });
  const pick = fc.getByRole("button", { name: new RegExp(`^${account}`) });
  for (let step = 0; step < 3; step++) {
    await agree.or(guest).or(pick).first().waitFor({ timeout: 60_000 });
    if (await pick.isVisible()) break;
    if (await agree.isVisible()) await agree.click();
    else if (await guest.isVisible()) await guest.click();
  }
  await pick.click({ timeout: 60_000 });
  await fc.getByRole("button", { name: "Connect account" }).click();
  // Stripe may offer to save the bank with Link first (since October 2026): finish without it.
  const done = fc.getByRole("button", { name: /^Continue to / });
  const noSave = fc.getByRole("button", { name: "Finish without saving" });
  await done.or(noSave).first().waitFor({ timeout: 60_000 });
  if (await noSave.isVisible()) await noSave.click();
  await done.click({ timeout: 60_000 });
  await page.getByTestId("hosted-payment-submit-button").click();
}

/** The app's own API from inside the page (same origin, the session's cookie). */
export async function appFetch(
  page: Page,
  path: string,
  body: unknown,
): Promise<{ status: number; detail: unknown }> {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(p as string, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, detail: (j as { detail?: unknown }).detail };
    },
    [path, body] as const,
  );
}

/** For requests refused before the words are compared (already subscribed, blocked, a stale
 * version, no step-up): the server builds the real lines and refuses any others. */
export const CONSENT = {
  version: "2026-10-24",
  lines: ["$3.00 today, then every month."],
  agreement: "I have read and understood these terms.",
  accepted: true,
};

/** The ticked "If you cancel" lines exactly as the server builds them (October 28, 2026). */
export async function cancelConsent(page: Page): Promise<typeof CONSENT & { tz: string }> {
  return page.evaluate(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await fetch(`/api/billing/consent/cancel?tz=${encodeURIComponent(tz)}`);
    const j = (await r.json()) as { version: string; lines: string[]; agreement: string };
    return { version: j.version, lines: j.lines, agreement: j.agreement, tz, accepted: true };
  });
}

/** Answer Stripe's 3-D Secure test page (its own frame, found by name wherever it nests). */
export async function answer3ds(page: Page, choice: "Complete" | "Fail"): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const frame = page.frame({ name: "stripe-challenge-frame" });
    const button = frame?.getByRole("button", { name: new RegExp(`^${choice}$`, "i") });
    if (button && (await button.isVisible().catch(() => false))) {
      await page.waitForTimeout(1000); // the test page wires its buttons a moment after showing
      await button.click();
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("the 3-D Secure test page never appeared");
}
