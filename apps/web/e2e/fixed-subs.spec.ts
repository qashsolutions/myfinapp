import { expect, test } from "@playwright/test";
import { isoInDays, readyAccount } from "./helpers.ts";

/**
 * Three months of subscriptions and rent, with Spotify's price going up today and two video
 * services. Dated from the day the suite runs (monthly gaps of 30 days), so it passes any day.
 */
function statementWithSubscriptions() {
  const [d60, d30, d0] = [isoInDays(-60), isoInDays(-30), isoInDays(0)];
  const rows = [
    "Posting Date,Description,Amount",
    `${d60},Spotify,-11.99`,
    `${d30},Spotify,-11.99`,
    `${d0},Spotify,-12.99`,
    `${d60},Netflix,-15.49`,
    `${d30},Netflix,-15.49`,
    `${d0},Netflix,-15.49`,
    `${d60},Hulu,-17.99`,
    `${d30},Hulu,-17.99`,
    `${d0},Hulu,-17.99`,
    `${d60},OAK APARTMENT RENT,"-1,500.00"`,
    `${d30},OAK APARTMENT RENT,"-1,500.00"`,
    `${d0},OAK APARTMENT RENT,"-1,500.00"`,
    `${d0},ACME PAYROLL,"2,400.00"`,
    `${d0},CORNER MKT #214,-42.17`,
    `${d0},BLUE DOOR CAFE,-8.50`,
    "",
  ];
  return { name: "subs.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) };
}

test("@phone the subscription check asks, shows the price rise and two video services, and Fixed vs flexible splits the month", async ({
  page,
}) => {
  await readyAccount(page, "fixedsubs");

  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(statementWithSubscriptions());
  await expect(page.getByText("subs.csv · 15 rows")).toBeVisible();
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 15 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();

  // Home finds the four bills; confirming them makes three subscriptions and the rent.
  await page.goto("/");
  await page.getByRole("button", { name: "Confirm all 4" }).click();
  // Nothing has been answered yet, so Home asks about the costliest: 17.99 × 12.
  const homeCheck = page.getByRole("link", { name: /Subscription check: Still using Hulu\?/ });
  await expect(homeCheck).toContainText("$215.88 a year");
  await homeCheck.click();

  await expect(page).toHaveURL(/\/subscriptions$/);
  const check = page.getByRole("region", { name: "Subscription check" });
  await expect(check).toContainText("Check");
  await expect(check).toContainText("Still using Hulu? $215.88 a year");
  const facts = check.getByRole("list", { name: "From your charges" });
  await expect(facts).toContainText("Spotify went from $11.99 to $12.99");
  // (215.88 + 185.88) ÷ 12 = 33.48
  await expect(facts).toContainText("2 video services · $33.48 a month together");
  await expect(check).not.toContainText(/unused/i);

  await check.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("status")).toContainText("Kept Hulu");
  await expect(check).toContainText("Still using Netflix? $185.88 a year");

  // Fixed vs flexible on Insights: bills and subscriptions are fixed, groceries and cafe flexible.
  await page.goto("/insights");
  const card = page.getByRole("link", { name: "Fixed vs flexible" });
  await expect(card).toContainText(/% kept · fixed \$[\d,]+\.\d\d · flexible \$50\.67/);
  await expect(card).toContainText("Most room: Dining $8.50");
  await card.click();
  await expect(page.getByRole("heading", { level: 1, name: "Fixed vs flexible" })).toBeVisible();
  const categories = page.getByRole("region", { name: "Each category" });
  await expect(categories.getByRole("row", { name: /Groceries/ })).toContainText("$42.17");
  await expect(categories.getByRole("row", { name: /Subscriptions/ })).toContainText("$0.00");
});
