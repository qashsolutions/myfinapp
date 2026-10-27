import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIXTURES, readyAccount } from "./helpers.ts";

test("@phone swipe an entry to Don't count and undo, arrange Home, the bills calendar", async ({
  page,
}) => {
  await readyAccount(page, "everyday");
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

  // Swipe left on an entry: the actions show; Don't count, then Undo.
  const row = page.getByRole("button", { name: /CORNER MKT #214/ });
  const box = await row.boundingBox();
  if (!box) throw new Error("no row");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width - 20, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 140, y, { steps: 8 });
  await page.mouse.move(box.x + box.width - 260, y, { steps: 8 });
  await page.mouse.up();
  const item = page.locator("li", { has: row });
  await item.getByRole("button", { name: "Don't count" }).click();
  await expect(page.getByText("Not counted in spending")).toBeVisible();
  await expect(item).toContainText("Not counted");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(item).not.toContainText("Not counted");

  // Customize Home: move a card with the keyboard-friendly buttons.
  await page.goto("/");
  await page.getByRole("button", { name: "Customize Home" }).click();
  const sheet = page.getByRole("dialog", { name: "Customize Home" });
  const first = sheet.getByRole("listitem").first();
  const firstName = (await first.innerText()).split("\n")[0] ?? "";
  await sheet.getByRole("button", { name: `Move ${firstName} down` }).click();
  await expect(sheet.getByRole("listitem").nth(1)).toContainText(firstName);
  await sheet.getByRole("button", { name: "Reset to the usual order" }).click();
  await expect(sheet.getByRole("listitem").first()).toContainText(firstName);
  await sheet.getByRole("button", { name: "Done" }).click();

  // A payday from Budget, so Next 30 days has something on its calendar.
  await page.goto("/budget");
  await page
    .getByLabel(/paycheck/i)
    .first()
    .fill("2600");
  await page.getByRole("radio", { name: "Twice a month" }).check();
  await page.getByLabel("Next payday").fill("2026-10-31");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Needs · 50%/)).toBeVisible();

  // Next 30 days: the List / Calendar switch shows the paydays on a calendar.
  await page.goto("/forecast");
  const upcoming = page.getByRole("region", { name: "Upcoming" });
  await upcoming.getByText("Calendar", { exact: true }).click();
  const calendar = upcoming.getByRole("table");
  await expect(calendar).toBeVisible();
  await calendar.getByRole("button", { name: /^Oct 31: Paycheck \+\$2,600\.00/ }).click();
  await expect(upcoming).toContainText("Paycheck");
});
