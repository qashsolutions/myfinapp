import { expect, type Page, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/** YYYY-MM-DD `days` from today, in the browser's local date. */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function addBill(page: Page, name: string, amount: string, days: number) {
  await page.getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a bill or income" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByLabel("Amount").fill(amount);
  await sheet.getByLabel("Next date").fill(inDays(days));
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sheet).toBeHidden();
}

async function addEntry(page: Page, merchant: string, amount: string, moneyIn = false) {
  await page.goto("/add");
  if (moneyIn) await page.getByText("Money in", { exact: true }).click();
  await page.getByLabel("Amount").fill(amount);
  await page.getByLabel("Merchant").fill(merchant);
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions$/);
}

test("@phone the visual screens: Bills, the weekly recap, Goals and the Plan screen", async ({
  page,
}) => {
  await readyAccount(page, "tour");
  const shot = (name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

  // Bills: at a glance, then each with its badge and countdown.
  await page.goto("/bills");
  await addBill(page, "Rent", "1200", 5);
  await addBill(page, "Phone", "60", 12);
  await expect(page.getByRole("region", { name: "Next 30 days of bills" })).toContainText(
    "$1,260.00 in bills",
  );
  await expect(page.getByRole("list", { name: "Bills and income" })).toContainText("In 5 days");
  await shot("bills");

  // A week with money in and out, and a jar with a deposit.
  await addEntry(page, "Paycheck", "2000", true);
  await addEntry(page, "Blue Bottle", "12.50");
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Create jar" }).click();
  await page.getByLabel("Other amount").fill("100");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("img", { name: /^[1-9]\d* percent$/ })).toBeVisible();

  await page.goto("/recap");
  await expect(page.getByText("Got $2,000.00")).toBeVisible();
  await expect(page.getByText("Rent")).toBeVisible(); // coming up
  await shot("recap");

  // A second jar, so the list has a row under the top jar's card.
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Create jar" }).click();
  await page.getByLabel("Other amount").fill("40");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("img", { name: /^[1-9]\d* percent$/ })).toBeVisible();
  await page.goto("/goals");
  await expect(page.locator(".goal-row__fill").first()).toBeVisible();
  await shot("goals");

  await page.goto("/me/plan");
  const priv = page.getByRole("article", { name: "Private" });
  await expect(priv).toContainText("Every account. Never linked. Fully private.");
  await expect(priv.getByRole("listitem")).toHaveCount(5);
  await shot("plan");
});

test("@phone the forecast: Covered in one word, pay and bills on the line, a what-if, a year ahead", async ({
  page,
}) => {
  await readyAccount(page, "ahead");
  const shot = (name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });

  await page.goto("/bills");
  await page.getByRole("button", { name: "+ Add" }).click();
  const pay = page.getByRole("dialog", { name: "Add a bill or income" });
  await pay.getByLabel("Name").fill("Paycheck");
  await pay.getByLabel("Amount").fill("2400");
  await pay.getByText("Income", { exact: true }).click();
  await pay.getByText("Every 2 weeks", { exact: true }).click();
  await pay.getByLabel("Next date").fill(inDays(4));
  await pay.getByRole("button", { name: "Add", exact: true }).click();
  await expect(pay).toBeHidden();
  await addBill(page, "Rent", "1650", 9);
  await addBill(page, "Phone", "60", 15);
  await addBill(page, "Car insurance", "180", 21);

  await page.goto("/forecast");
  await page.getByRole("button", { name: "Enter a balance" }).click();
  const sheet = page.getByRole("dialog", { name: /Balance in/ });
  await sheet.getByLabel("Balance").fill("1500");
  await sheet.getByRole("button", { name: "Save balance" }).click();
  await expect(page.getByRole("region", { name: "Covered" })).toBeVisible();
  await expect(page.getByRole("img", { name: /paydays and 3 bills marked/ })).toBeVisible();
  await shot("forecast-month");

  const tryCard = page.getByRole("region", { name: "What if" });
  await tryCard.getByRole("slider", { name: /Set aside each payday/ }).fill("30000");
  await expect(tryCard.getByRole("status")).toContainText("set aside by");
  await tryCard.scrollIntoViewIfNeeded();
  await shot("forecast-whatif");

  await page.getByText("Year", { exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Next year" })).toBeVisible();
  await page.locator(".up-month summary").first().click(); // a month opens to its items
  await shot("forecast-year");
});

test("@phone Later: savings by the age you choose, at your own rates", async ({ page }) => {
  await readyAccount(page, "later");
  await page.goto("/insights/later");
  const yours = page.getByRole("region", { name: "Your numbers" });
  await yours.getByLabel("Saved now").fill("40000");
  await yours.getByLabel("Each month").fill("600");
  await yours.getByLabel("Goal (optional)").fill("1000000");
  await yours.getByRole("slider").fill("62");
  await expect(page.getByRole("region", { name: "Behind" })).toContainText("at 62");
  await page.screenshot({ path: test.info().outputPath("later.png"), fullPage: true });
  await page.goto("/insights");
  await expect(page.getByRole("link", { name: "Later" })).toContainText("at 62");
  await page.getByRole("link", { name: "Later" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("later-card.png") });
});

test("@phone views: Month · Quarter · Year · YTD · Next, and Earlier", async ({ page }) => {
  await readyAccount(page, "views");
  await addEntry(page, "Paycheck", "2400", true);
  await addEntry(page, "Groceries", "86.20");
  await page.goto("/money");
  await page.getByText("YTD", { exact: true }).click();
  await expect(page.getByRole("group", { name: "this year so far" })).toContainText("+$2,400.00");
  await page.screenshot({ path: test.info().outputPath("views-ytd.png") });
  await page.getByText("Next", { exact: true }).click();
  await expect(page.getByRole("region", { name: /^(Saving|Over|Start)$/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("views-next.png") });
  await page.goto("/");
  await expect(page.getByText("Kept", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("words-home.png"), fullPage: true });
  await page.goto("/insights");
  await expect(page.getByRole("link", { name: "Later" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("words-insights.png"), fullPage: true });
});
