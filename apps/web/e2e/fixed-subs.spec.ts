import { expect, type Page, test } from "@playwright/test";
import { isoInDays, readyAccount } from "./helpers.ts";

/** With SHOTS_PREFIX set (a local run only), full-page shots in light and dark for review. */
async function shots(page: Page, name: string) {
  const prefix = process.env.SHOTS_PREFIX;
  if (!prefix) return;
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${prefix}${name}-${test.info().project.name}-${colorScheme}.png`,
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

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

/** Where the owner's screenshots of each changed screen go (kept; the owner looks at them). */
const SHOTS = process.env.E2E_SHOTS_DIR;

/** The same screen at phone and computer width, light and dark, into SHOTS (desktop run only). */
async function shoot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (!SHOTS || test.info().project.name !== "desktop") return;
  const before = page.viewportSize();
  for (const [size, width, height] of [
    ["phone", 412, 915],
    ["desktop", 1280, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png`, fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (before) await page.setViewportSize(before);
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

  // The picture first: where the money goes by kind, then the yearly total
  const hero = page.getByRole("region", { name: "A year of subscriptions" });
  await expect(
    hero.getByRole("img", {
      name: "Where it goes each month: Video streaming $33.48 a month, Music $11.99 a month",
    }),
  ).toBeVisible();
  await expect(check.getByRole("img", { name: "Hulu: $215.88 of $545.64 a year" })).toBeVisible();
  await shoot(page, "H-subscriptions");

  await check.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Kept Hulu. Qash will ask again in 90 days.",
  );
  await expect(check).toContainText("Still using Netflix? $185.88 a year");

  // Adjust: the person's own interval, and an own value out of range says so
  await page.getByRole("button", { name: "Adjust" }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust subscription check" });
  await sheet.getByRole("group", { name: "Ask again" }).getByText("30 days").click();
  const own = sheet.getByRole("textbox", { name: "Your own number of days before a renewal" });
  await own.fill("200");
  await sheet.getByRole("button", { name: "Use" }).nth(1).click();
  await expect(sheet.getByRole("alert")).toContainText("from 1 to 90");
  await own.fill("21");
  await sheet.getByRole("button", { name: "Use" }).nth(1).click();
  await shoot(page, "H-subscriptions-adjust");
  await sheet.getByRole("button", { name: "Done" }).click();

  // The person's own kind wins: Spotify counted with the video services
  await page
    .getByRole("region", { name: "Spotify" })
    .getByRole("button", { name: /Change the kind of Spotify/ })
    .click();
  const kinds = page.getByRole("dialog", { name: "What kind is Spotify?" });
  await shoot(page, "H-subscriptions-kind");
  await kinds.getByText("Video streaming", { exact: true }).click();
  // (215.88 + 185.88 + 143.88) ÷ 12 = 45.47
  await expect(facts).toContainText("3 video services · $45.47 a month together");
  await page.goto("/");
  await expect(
    page
      .getByRole("link", { name: /Subscription check/ })
      .getByRole("img", { name: /Where it goes/ }),
  ).toBeVisible();
  await shoot(page, "H-home");
  await page.goto("/subscriptions");

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
  // The month as a ring with the kept rate in its middle, and the kept rate by month
  await expect(page.getByRole("img", { name: /% kept\. Fixed \$/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /^Kept rate by month/ })).toBeVisible();
  await shots(page, "fixed-flexible");

  // Adjust: the person's own call, groceries treated as fixed
  await page.getByRole("button", { name: "Adjust" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust fixed vs flexible" });
  const groceries = adjust.getByRole("group", { name: "Groceries" });
  await groceries.getByText("Fixed", { exact: true }).click();
  await expect(groceries.getByRole("radio", { name: "Fixed" })).toBeChecked();
  await shots(page, "fixed-flexible-adjust");
  await adjust.getByRole("button", { name: "Done" }).click();
  await expect(categories.getByRole("row", { name: /Groceries/ })).toContainText(
    "Groceries$42.17$0.00",
  );

  // A room category opens What if → Spend less on it; under $25 the amount is the spending itself
  const room = page.getByRole("region", { name: "Most room" });
  await room.getByRole("link", { name: /^Dining \$8\.50/ }).click();
  await expect(page).toHaveURL(/\/what-if\?lever=spend&category=cat-dining&amount=850$/);
  const spend = page.getByRole("region", { name: "Spend less" });
  await expect(spend.getByRole("combobox", { name: "Category" })).toHaveValue("cat-dining");
});
