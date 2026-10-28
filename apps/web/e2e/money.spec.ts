import { expect, test } from "@playwright/test";
import { readyAccount, statementThisMonth } from "./helpers.ts";

test("import a statement, add an entry, your own category, Don't count, ranges and review", async ({
  page,
}) => {
  await readyAccount(page, "money");

  // Import: read on this device, columns matched, the card payment confirmed as a transfer.
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(statementThisMonth());
  await expect(page.getByText("statement.csv · 4 rows")).toBeVisible();
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Match columns" })).toBeVisible();
  await page.getByRole("button", { name: "Looks right" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();

  // Home: Kept this month is In − Out (2,400 − 42.17 − 2.75; the card payment is a transfer).
  await page.goto("/");
  await expect(page.getByText("$2,355.08 kept")).toBeVisible();

  // An entry by hand, in a category of your own.
  await page.getByRole("button", { name: "Add entry or receipt" }).click();
  await page.getByRole("button", { name: /An entry/ }).click();
  await page.getByLabel("Amount").fill("12.50");
  await page.getByLabel("Merchant").fill("Blue Bottle");
  await page.getByRole("button", { name: "+ New" }).click();
  const sheet = page.getByRole("dialog", { name: "New category" });
  await sheet.getByLabel("Name").fill("Coffee");
  await sheet.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByRole("radio", { name: "Coffee" })).toBeChecked();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions$/);
  await page.goto("/");
  await expect(page.getByText("$2,342.58 kept")).toBeVisible();

  // Don't count: out of spending, still listed.
  await page.goto("/money?view=transactions");
  await page.getByText("Blue Bottle").click();
  const counted = page.getByRole("switch", { name: "Count in my spending" });
  await expect(counted).toBeChecked();
  await page.getByText("Count in my spending", { exact: true }).click();
  await expect(counted).not.toBeChecked();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions$/);
  await page.goto("/");
  await expect(page.getByText("$2,355.08 kept")).toBeVisible();

  // Time ranges on Money in & out.
  await page.goto("/money");
  await page.getByRole("radio", { name: "the last 3 months" }).check();
  await expect(page.getByRole("group", { name: "the last 3 months" })).toContainText("+$2,400.00");

  // Sort your spending opens and works from what isn't sorted.
  await page.goto("/review");
  await expect(page.getByRole("heading", { level: 1, name: "Sort your spending" })).toBeVisible();
});
