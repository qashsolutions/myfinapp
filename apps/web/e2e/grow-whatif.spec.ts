import { expect, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

test("@phone a jar that grows, then What if: more on a loan and spend less", async ({ page }) => {
  await readyAccount(page, "grow");

  // Kids' education turns "Grows over time" on: $2,000 today, rising 5% and growing 5% a year,
  // six months out is $2,050.52 then and about $338.21 a month (whatever the month the suite runs).
  await page.goto("/goals/new");
  await page.getByRole("button", { name: /Change what it's for/ }).click();
  await page.getByRole("radio", { name: "Kids' education" }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("switch", { name: /Grows over time/ })).toBeChecked();
  await expect(page.getByRole("region", { name: "Pace" })).toContainText(
    /About \$338\.21 a month from now · \$2,050\.52 by \w+ \d{4}/,
  );
  await page.getByRole("button", { name: "Create jar" }).click();
  const grows = page.getByRole("region", { name: "Grows over time" });
  await expect(grows).toContainText("On track");
  await expect(grows).toContainText("About $338.21 a month from now");
  await expect(grows).toContainText("not a prediction or advice");
  // One monthly amount: the flat weekly pace of the future cost is never beside it, and the
  // quick chip is the month.
  await expect(page.getByRole("region", { name: "Pace" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+$338.21" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("grow-jar.png"), fullPage: true });

  // $300 put in today: $100 a month at the last three months' pace.
  await page.getByRole("textbox", { name: "Other amount" }).fill("300");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("region", { name: "Recent" })).toContainText("+$300.00");

  // A $300 card at 12% with a $100 minimum.
  await page.goto("/bills");
  await page.getByText("Debt payoff", { exact: true }).click();
  await page.getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Name").fill("Card");
  await sheet.getByLabel("Balance").fill("300");
  await sheet.getByLabel("APR %").fill("12");
  await sheet.getByLabel("Minimum payment").fill("100");
  await sheet.getByRole("button", { name: "Add", exact: true }).click();

  // Lever 1: $100 more a month pays it in 2 months instead of 4, $2.11 less interest.
  await page.getByRole("link", { name: "What if I put more on one loan?" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "What if" })).toBeVisible();
  const changes = page.getByRole("region", { name: "What changes for Card" });
  await expect(changes).toContainText("Sooner");
  await expect(changes).toContainText("Card paid off 2 months sooner · $2.11 less interest");

  // Lever 3: $50 less on Dining. The grows jar keeps its own monthly plan, so Spend less never
  // fills it (its flat months-to-fill would contradict the plan). On the card instead: 3
  // months, $1.56 less interest.
  await page.getByText("Spend less", { exact: true }).click();
  await page.getByRole("radio", { name: "$50.00" }).check();
  await expect(page.getByRole("region", { name: "No jar yet" })).toContainText(
    "A jar that grows over time keeps its own monthly plan",
  );
  await expect(page.getByRole("region", { name: "What changes for Kids' education" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "What changes for your debts" })).toContainText(
    "Debt-free 1 month sooner · $1.56 less interest",
  );
  await expect(page.getByText(/not advice/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("what-if.png"), fullPage: true });
});
