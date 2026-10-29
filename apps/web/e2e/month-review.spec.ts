import { expect, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The browser's clock is set, never the calendar: the month just ended is the one before the
 * month the suite runs in, its budget is made on its 15th, and the review is opened on the 3rd of
 * this month (inside the Home card's first week). Only the page's Date moves; the server keeps
 * real time, so sign-in and the trial behave as usual.
 */
const now = new Date();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
const day = (d: number) => iso(new Date(lastMonth.getFullYear(), lastMonth.getMonth(), d));
const BUDGET_DAY = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 15, 12);
const REVIEW_DAY = new Date(now.getFullYear(), now.getMonth(), 3, 12);
const MONTH_NAME = `${MONTHS[lastMonth.getMonth()]} ${lastMonth.getFullYear()}`;

function lastMonthStatement() {
  const rows = [
    "Posting Date,Description,Amount",
    `${day(1)},ACME PAYROLL,"2,400.00"`,
    `${day(5)},CORNER MKT #214,-42.17`,
    `${day(10)},BLUE DOOR CAFE,-120.00`,
    "",
  ];
  return { name: "last-month.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) };
}

test("@phone the month review shows last month over plan and opens What if with the one change", async ({
  page,
}) => {
  await readyAccount(page, "monthreview");
  await page.clock.setFixedTime(BUDGET_DAY);

  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(lastMonthStatement());
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 3 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();

  // That month's budget, zero-based: Dining planned $20, spent $120 → $100 over (Groceries,
  // with nothing planned, is waiting for its job, not over: as on Budget and in the alert).
  await page.goto("/budget");
  await page
    .getByLabel(/paycheck/i)
    .first()
    .fill("2000");
  await page.getByRole("radio", { name: "Monthly" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Zero-based", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const planned = page.getByRole("region", { name: "Planned by category" });
  await planned.getByRole("textbox", { name: "Dining planned" }).fill("20");
  await planned.getByRole("textbox", { name: "Dining planned" }).press("Enter");
  await expect(planned).toContainText("$120.00 of $20.00 · $100.00 over");

  // Early the next month: Insights has the month just ended. Leave the app first, so its idle
  // timer never sees the jump as weeks without activity and locks the session.
  await page.goto("about:blank");
  await page.clock.setFixedTime(REVIEW_DAY);
  await page.goto("/insights");
  const card = page.getByRole("link", { name: "Your month" });
  // 2,400 − 42.17 − 120 = 2,237.83 kept
  await expect(card).toContainText(`${MONTH_NAME}: $2,237.83 kept`);
  await card.click();

  await expect(page.getByRole("heading", { level: 1, name: "Your month" })).toBeVisible();
  await expect(page.getByRole("region", { name: "How it went" })).toContainText("Kept $2,237.83");
  const budget = page.getByRole("region", { name: "Budget" });
  await expect(budget).toContainText("1 line over · Dining $100.00 over");
  await expect(page.getByRole("button", { name: "Later ›" })).toBeDisabled();
  const change = page.getByRole("region", { name: "One change" });
  await expect(change).toContainText("Dining $100 less a month → $1,200 a year");
  await expect(change).not.toContainText(/you should/i);
  await page.screenshot({ path: test.info().outputPath("month-review.png"), fullPage: true });

  await change.getByRole("link", { name: "Try it in What if" }).click();
  await expect(page).toHaveURL(/\/what-if\?lever=spend&amount=10000&category=cat-dining$/);
  const spend = page.getByRole("region", { name: "Spend less" });
  await expect(spend.getByRole("combobox", { name: "Category" })).toHaveValue("cat-dining");
  await expect(spend).toContainText("Then put the $100.00 a month toward a jar or your debts.");

  // Home has the card during the first week, until Done.
  await page.goto("/");
  const homeCard = page.getByRole("link", { name: /Your month: .*\$2,237\.83 kept/ });
  await expect(homeCard).toBeVisible();
  await homeCard.click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("link", { name: /Kept this month/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Your month:/ })).toHaveCount(0);
});
