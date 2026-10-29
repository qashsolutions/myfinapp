import { expect, type Page, test } from "@playwright/test";
import { isoInDays, readyAccount } from "./helpers.ts";

async function addDebt(page: Page, name: string, balance: string, apr: string, minimum: string) {
  await page.getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a card or loan" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Balance").fill(balance);
  await sheet.getByLabel("APR %").fill(apr);
  await sheet.getByLabel("Minimum payment").fill(minimum);
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet).toBeHidden();
}

test("@phone debt payoff: smallest balance first beside highest rate first, and Home says when you're debt-free", async ({
  page,
}) => {
  await readyAccount(page, "debt");
  await page.goto("/bills?tab=debt");
  await expect(page.getByRole("radio", { name: "Debt payoff" })).toBeChecked();
  // The golden pair bills.payoff_plan/snowball_pays_the_smallest_balance_first and
  // avalanche_on_the_same_debts_costs_less_interest.
  await addDebt(page, "Card", "200", "24", "20");
  await addDebt(page, "Loan", "100", "12", "20");
  const plan = page.getByRole("region", { name: "Payoff plan" });
  await plan.getByRole("textbox", { name: "Other extra amount each month" }).fill("50");
  await plan.getByRole("button", { name: "Use" }).click();

  const both = plan.getByRole("list", { name: "Both orders side by side" });
  await expect(both).toContainText("$10.84 interest");
  await expect(both).toContainText("$12.40 interest");
  await expect(plan.getByRole("radio", { name: "Highest rate first" })).toBeChecked();

  await plan.locator("label.chip-option", { hasText: "Smallest balance first" }).click();
  await expect(plan.getByRole("radio", { name: "Smallest balance first" })).toBeChecked();
  await expect(plan).toContainText("Loan: paid off");
  await expect(plan).toContainText("$1.31 interest");
  await expect(page.getByRole("list", { name: "Debts, smallest balance first" })).toBeVisible();

  await page.goto("/");
  const card = page.getByRole("link", { name: "Open Debt payoff" });
  await expect(card).toContainText("Debt-free");
  await expect(card).toContainText(/by \w+ \d{4}/);
  await card.click();
  await expect(page.getByRole("region", { name: "Payoff plan" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("debt-payoff.png"), fullPage: true });
});

test("credit habits: a card with its own due day and a payment before it shows an on-time streak", async ({
  page,
}) => {
  await readyAccount(page, "credit");
  // Bought 20 days ago, paid back 6 days ago to a $0 balance; due 5 days ago. One due date is
  // checked and nothing was owed on it after the payment: on time.
  const due = isoInDays(-5);
  const dueDay = String(Number(due.slice(8, 10)));
  const csv = [
    "Posting Date,Description,Amount,Balance",
    `${isoInDays(-20)},CORNER MKT,-50.00,-50.00`,
    `${isoInDays(-6)},REFUND CORNER MKT,50.00,0.00`,
    "",
  ].join("\n");
  await page.goto("/import");
  await page
    .getByLabel(/Choose a statement file/)
    .setInputFiles({ name: "card.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Visa");
  await page.getByLabel("Type", { exact: true }).selectOption("credit_card");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 2 transactions" }).click();
  await expect(page.getByText("CORNER MKT").first()).toBeVisible();

  // Its own due day, typed in: any day 1 to 31.
  await page.goto("/me/accounts");
  const visa = page.getByRole("region", { name: "Visa" });
  await visa.getByRole("button", { name: "Edit or remove" }).click();
  const sheet = page.getByRole("dialog", { name: "Edit account" });
  await sheet.getByLabel("Own due day, 1 to 31").fill(dueDay);
  await sheet.getByRole("button", { name: "Use" }).click();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/bills?tab=debt");
  const habits = page.getByRole("region", { name: /Credit habits/ });
  await expect(habits).toContainText("Steady");
  await expect(habits).toContainText("1 payment on time in a row");
  await expect(habits).toContainText("Education only. Qash never sees or shows a credit score.");

  await habits.getByRole("link", { name: "See each card" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Credit habits" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Visa" })).toContainText(
    "1 payment on time in a row",
  );
  await page.screenshot({ path: test.info().outputPath("credit-habits.png"), fullPage: true });
});
