import { expect, test } from "@playwright/test";
import { isoInDays, readyAccount } from "./helpers.ts";

/** Four weeks of groceries and takeout, every 7 days up to today. */
function weeklyShopping() {
  const rows = ["Posting Date,Description,Amount"];
  for (const back of [21, 14, 7, 0]) {
    const day = isoInDays(-back);
    rows.push(`${day},TRADER JOES #552,-84.37`);
    rows.push(`${day},CHIPOTLE 1234,-14.50`);
  }
  rows.push("");
  return { name: "weekly.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) };
}

test("@phone weekly shopping is regular spending; the person's own call and categories win (invariant 52)", async ({
  page,
}) => {
  await readyAccount(page, "regularbills");
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(weeklyShopping());
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 8 transactions" }).click();
  await expect(page.getByText("TRADER JOES #552").first()).toBeVisible();

  // Both are everyday spending on a schedule, not bills.
  await page.goto("/bills");
  const regular = page.getByRole("region", { name: "Regular spending, not bills" });
  await expect(regular).toContainText("TRADER JOES #552");
  await expect(regular).toContainText("CHIPOTLE 1234");

  // Dining is not everyday for this person: Chipotle becomes a bill to look at.
  await page.getByRole("button", { name: "Adjust bills" }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust bills" });
  await sheet.getByRole("button", { name: "Dining", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Dining", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("region", { name: "Suggestion: CHIPOTLE 1234" })).toBeVisible();
  await expect(regular).not.toContainText("CHIPOTLE");

  // Trader Joe's is a bill by the person's own call: it joins the bills and the next 30 days.
  await regular.getByRole("button", { name: "TRADER JOES #552: this is a bill" }).click();
  await expect(page.getByRole("list", { name: "Bills and income" })).toContainText(
    "TRADER JOES #552",
  );
  await page.goto("/forecast");
  await expect(page.getByText("TRADER JOES #552").first()).toBeVisible();
});
