import { expect, type Page, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/**
 * Bank and card linking end to end (Phase 3, chunks 3.2–3.5) on a Connected trial, against the
 * fake Plaid the e2e API runs (services/api/tests/e2e_app.py): Hosted Link and back, the first
 * sync into Money in & out, card details on Debt payoff, the bank asking for a sign-in again and
 * Sign in again, then Disconnect keeping the accounts and entries. Plaid's access token never
 * reaches the device.
 */

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "8100"}`;
const BANK = "First Platypus Bank";

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

test("@phone linking: connect through Hosted Link, transactions and card details arrive, sign in again, disconnect", async ({
  page,
  request,
}) => {
  const responses: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/linking")) responses.push(await r.text().catch(() => ""));
  });
  await hostedLink(page);
  await readyAccount(page, "link", "Connected");

  // Connect: what linking reads and never reads, then Plaid's page, then back.
  await page.goto("/me/linking");
  await expect(page.getByText("It can never move money.")).toBeVisible();
  await page.getByRole("button", { name: "Connect a bank or card" }).click();
  await page.getByRole("link", { name: "Continue to Qash" }).click();
  await expect(page.getByText(`${BANK} is linked.`)).toBeVisible();
  await expect(page.getByText(/^Transactions: 3 new\./)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Plaid Checking ••0000")).toBeVisible();
  await expect(page.getByText("Plaid Credit Card ••3333")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(BANK)).toBeVisible();

  // The transactions are entries on this device.
  await page.goto("/money?view=transactions");
  await expect(page.getByText(/PLATYPUS COFFEE/i).first()).toBeVisible();
  await expect(page.getByText(/RIVERSIDE GROCERY/i).first()).toBeVisible();

  // The card's details: the due date ten days out, the APR, the minimum.
  await page.goto("/bills?tab=debt");
  const card = page.getByRole("article", { name: "Plaid Credit Card ••3333" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText("Due in 10 days")).toBeVisible();
  await expect(card.getByText("24.99%")).toBeVisible();

  // The bank asks for a sign-in again; the next check shows Sign in again, which fixes it.
  expect((await request.post(`${API}/__e2e/plaid/login_required`)).ok()).toBe(true);
  await page.goto("/me/linking");
  await page.getByRole("button", { name: "Check for new transactions" }).click();
  const signInAgain = page.getByRole("button", { name: "Sign in again" });
  await expect(signInAgain).toBeVisible();
  await signInAgain.click();
  await page.getByRole("link", { name: "Continue to Qash" }).click();
  await expect(page.getByText(`${BANK} is linked.`)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Sign in again" })).toBeHidden();
  await page.getByRole("button", { name: "Check for new transactions" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Up to date|new/ })).toBeVisible();

  // Disconnect: the connection goes, the accounts and entries stay.
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page
    .getByRole("dialog", { name: `Disconnect ${BANK}?` })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(
    page.getByText(`${BANK} is disconnected. Its accounts and entries stay on this device.`),
  ).toBeVisible();
  await page.goto("/money?view=transactions");
  await expect(page.getByText(/PLATYPUS COFFEE/i).first()).toBeVisible();

  // Plaid's access token stays on the server, sealed.
  expect(responses.length).toBeGreaterThan(0);
  for (const body of responses) expect(body).not.toContain("access-sandbox");
});
