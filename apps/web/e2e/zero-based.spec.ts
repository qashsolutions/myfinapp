import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURES, readyAccount } from "./helpers.ts";

test("@phone zero-based: every dollar gets a job, money moves between lines, Home says what's left", async ({
  page,
}) => {
  await readyAccount(page, "zero");
  await page.goto("/import");
  await page
    .getByLabel(/Choose a statement file/)
    .setInputFiles(join(FIXTURES, "statement_oct.csv"));
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible(); // saved before moving on

  // Take-home $2,000 a month, zero-based.
  await page.goto("/budget");
  await page
    .getByLabel(/paycheck/i)
    .first()
    .fill("2000");
  await page.getByRole("radio", { name: "Monthly" }).check();
  await page.getByLabel("Next payday").fill("2026-10-31");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Zero-based", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const left = page.getByRole("region", { name: "Left to assign" });
  await expect(left).toContainText("$2,000.00");
  const planned = page.getByRole("region", { name: "Planned by category" });
  await expect(planned).toContainText("$42.17 spent · nothing planned yet");

  // Plan Groceries too low, then cover it from Transport.
  await planned.getByRole("textbox", { name: "Groceries planned" }).fill("30");
  await planned.getByRole("textbox", { name: "Groceries planned" }).press("Enter");
  await planned.getByRole("textbox", { name: "Transport planned" }).fill("100");
  await planned.getByRole("textbox", { name: "Transport planned" }).press("Enter");
  await expect(planned).toContainText("$42.17 of $30.00 · $12.17 over");
  await planned.getByRole("button", { name: "Cover it" }).click();
  const move = page.getByRole("dialog", { name: "Move money" });
  await move
    .getByRole("group", { name: "From" })
    .getByText(/^Transport/)
    .click();
  await move.getByRole("button", { name: "Move" }).click();
  await expect(planned).toContainText("$42.17 of $42.17 · $0.00 left");
  await expect(left).toContainText("$1,870.00");

  // Home says what still needs a job.
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open Budget" })).toContainText(
    "$1,870.00 left to assign",
  );

  // Assign what's left: every dollar has a job.
  await page.goto("/budget");
  await left.getByRole("button", { name: "Assign what's left" }).click();
  await page
    .getByRole("dialog", { name: "Assign what's left" })
    .getByRole("button", { name: "Savings" })
    .click();
  await expect(left).toContainText("Every dollar has a job.");
  await page.screenshot({ path: test.info().outputPath("zero-based.png"), fullPage: true });
});
