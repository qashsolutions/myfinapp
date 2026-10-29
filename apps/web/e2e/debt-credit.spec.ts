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
  // Due five days ago; paid the day before: one due date checked, on time.
  const due = isoInDays(-5);
  const paid = isoInDays(-6);
  const dueDay = String(Number(due.slice(8, 10)));

  await page.goto("/me/accounts");
  await page.getByRole("button", { name: "+ Add an account" }).click();
  const sheet = page.getByRole("dialog", { name: "Add an account" });
  await sheet.getByRole("textbox", { name: "Name" }).fill("Visa");
  await sheet.getByRole("combobox", { name: "Type" }).selectOption("credit_card");
  await sheet.getByLabel("Own due day, 1 to 31").fill(dueDay);
  await sheet.getByRole("button", { name: "Use" }).click();
  await sheet.getByRole("button", { name: "Add" }).click();
  await expect(sheet).toBeHidden();

  await page.goto("/add");
  await page.getByText("Money in", { exact: true }).click();
  await page.getByLabel("Amount").fill("50");
  await page.getByLabel("Merchant").fill("Card payment");
  await page.getByLabel("Date").fill(paid);
  await page.getByLabel("Account", { exact: true }).selectOption({ label: "Visa" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("Add entry");

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
