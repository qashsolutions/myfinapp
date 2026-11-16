import { expect, test } from "@playwright/test";
import { readyAccount, statementThisMonth } from "./helpers.ts";

/**
 * Search across the app (November 16, 2026): from any screen, everyday words and a typo find the
 * feature, the keyboard picks it, the setting it names is flashed, and nothing typed is sent.
 */

test("@phone search: everyday words, a typo and the keyboard open the right place", async ({
  page,
}) => {
  await readyAccount(page, "search");
  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));

  // From Budget, everyday words find Safe to spend.
  await page.getByRole("link", { name: "Budget" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Budget" })).toBeVisible();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Search" });
  await expect(sheet.getByText("Search runs only on this device")).toBeVisible();
  const box = sheet.getByRole("combobox", { name: "Search Qash" });
  await expect(box).toBeFocused();
  await box.fill("how much can i spend");
  await expect(sheet.getByRole("option").first()).toContainText("Safe to spend");
  await box.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Next 30 days" })).toBeVisible();

  // A typo still finds it; the arrow keys move down the list.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await box.fill("subscriptons");
  await expect(sheet.getByRole("option").first()).toContainText("Subscriptions");
  await box.press("Escape");
  await expect(sheet).toBeHidden();

  // A setting opens its screen with the row flashed.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await box.fill("dark mode");
  await sheet.getByRole("option", { name: /Dark mode/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Look & feel" })).toBeVisible();
  await expect(page.locator("#set-display")).toHaveClass(/settings-flash/);

  // Recent remembers the place, never the typing.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(sheet.getByRole("group", { name: "Recent" })).toContainText("Dark mode");
  await box.press("Escape");
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toMatch(/how much can i spend|subscriptons/i);

  // Nothing typed left the device.
  expect(sent.join("\n")).not.toMatch(/how%20much|how\+much|how much can|subscriptons/i);
});

test("search: ⌘K from the side rail's computer layout", async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 900, "computer layout only");
  await readyAccount(page, "search-desk");
  await page.keyboard.press("ControlOrMeta+k");
  const sheet = page.getByRole("dialog", { name: "Search" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("combobox").fill("net worth");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Net worth" })).toBeVisible();
  await expect(
    page.locator(".rail").getByRole("button", { name: "Search", exact: true }),
  ).toBeVisible();
});

test("@phone search your own data: a merchant and an amount from a statement, nothing sent", async ({
  page,
}) => {
  await readyAccount(page, "search-data");
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(statementThisMonth());
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();

  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));
  const sheet = page.getByRole("dialog", { name: "Search" });
  const box = sheet.getByRole("combobox", { name: "Search Qash" });

  // A merchant: all its entries and what they add up to.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await box.fill("corner");
  const merchants = sheet.getByRole("group", { name: "Merchants" });
  await merchants.getByRole("option", { name: /CORNER MKT/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: /CORNER MKT/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "What they add up to" })).toContainText("$42.17");
  // The search is never in the address, so a reload sends nothing of it to the server; the
  // tab keeps the list itself. Opened fresh (a pasted link), there's nothing to show.
  expect(page.url()).toMatch(/\/search\/entries$/);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /CORNER MKT/ })).toBeVisible();
  const fresh = await page.context().newPage();
  await fresh.goto("/search/entries");
  await expect(fresh.getByText("Searches aren't kept, so search again.")).toBeVisible();
  await fresh.close();

  // An amount opens its entry.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await box.fill("2.75");
  await sheet.getByRole("group", { name: "Entries" }).getByRole("option").first().click();
  await expect(page.getByRole("textbox", { name: "Merchant" })).toHaveValue("METRO TRANSIT");
  await expect(page.getByRole("textbox", { name: "Amount" })).toHaveValue("2.75");

  expect(sent.join("\n")).not.toMatch(/corner|metro|2\.75/i);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toMatch(/corner|metro/i);
});
