import { expect, type Request, test } from "@playwright/test";
import { readyAccount, statementThisMonth } from "./helpers.ts";

/** Every alert schedule the device registered with the server in this test. */
function scheduleBodies(page: import("@playwright/test").Page): string[] {
  const bodies: string[] = [];
  page.on("request", (r: Request) => {
    if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/alerts/schedule")
      bodies.push(r.postData() ?? "");
  });
  return bodies;
}

/** Phone: the Challenges tab; from 900px Goals shows jars and challenges side by side. */
async function showChallenges(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Goals" })).toBeVisible();
  const tab = page.getByRole("radio", { name: "Challenges" });
  if (await tab.isVisible()) await tab.click();
}

test("@phone a budget line past 90% says Close, and the alert leaves as a tag and a level only", async ({
  page,
}) => {
  const bodies = scheduleBodies(page);
  await readyAccount(page, "pace");
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(statementThisMonth());
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();

  // Zero-based, $2,000 a month; Groceries planned $45 against $42.17 spent (94%).
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
  await planned.getByRole("textbox", { name: "Groceries planned" }).fill("45");
  await planned.getByRole("textbox", { name: "Groceries planned" }).press("Enter");
  const groceries = planned
    .locator(".zb-line")
    .filter({ has: page.getByRole("button", { name: "Move money to or from Groceries" }) });
  await expect(groceries).toContainText("Close");
  await expect(groceries).toContainText("$42.17 of $45.00 · $2.83 left");

  // The schedule the server gets: a budget_pace item whose key names a month, a tag, a level.
  await expect
    .poll(() => bodies.some((b) => b.includes("budget_pace")), { timeout: 20_000 })
    .toBe(true);
  const body = bodies.filter((b) => b.includes("budget_pace")).at(-1) ?? "";
  const items = (JSON.parse(body) as { items: Array<Record<string, string>> }).items.filter(
    (i) => i.type === "budget_pace",
  );
  expect(items).toHaveLength(1);
  expect(Object.keys(items[0] ?? {}).sort()).toEqual(["dedupe_key", "due_at", "type"]);
  expect(items[0]?.dedupe_key).toMatch(/^budget:\d{4}-\d{2}:[a-p]{16}:9000$/);
  expect(body).not.toMatch(/Groceries|groceries|CORNER|4217|42\.17|4500/);
  await page.screenshot({ path: test.info().outputPath("budget-close.png"), fullPage: true });
});

test("@phone a member who reached the target says what helped, and it is saved", async ({
  page,
}) => {
  await readyAccount(page, "helped");
  await page.goto("/goals");
  await showChallenges(page);
  await page.getByRole("link", { name: "Start a challenge" }).click();
  await page.getByRole("radio", { name: "$500.00" }).click();
  const name = page.getByLabel("Your name, as members will see it");
  if (await name.isVisible()) await name.fill("Nia");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await page.getByRole("link", { name: "Log a deposit" }).click();
  await page.getByLabel("Other amount").fill("500");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("img", { name: "100 percent" })).toBeVisible();

  // Back on the challenge once the 100% reached the server.
  await page.getByRole("link", { name: "Back" }).click();
  await showChallenges(page);
  await page.getByRole("link", { name: /savings challenge/ }).click();
  const card = page.getByRole("region", { name: "What helped" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByText("Packed lunch").click();
  await card.getByText("Set money aside on payday").click();
  const saved = page.waitForRequest(
    (r) => r.method() === "PUT" && /\/api\/groups\/[^/]+\/helped$/.test(new URL(r.url()).pathname),
  );
  await card.getByRole("button", { name: "Save" }).click();
  expect(JSON.parse((await saved).postData() ?? "{}")).toEqual({
    choices: ["packed_lunch", "payday_set_aside"],
  });
  await expect(card).toContainText("Saved. Thanks for sharing.");
  await expect(card).toContainText("Shared");

  // It stays saved: a fresh load shows both picked.
  await page.reload();
  const again = page.getByRole("region", { name: "What helped" });
  await expect(again.getByRole("checkbox", { name: "Packed lunch" })).toBeChecked();
  await expect(again.getByRole("checkbox", { name: "Set money aside on payday" })).toBeChecked();
  await expect(again.getByRole("checkbox", { name: "Cooked at home" })).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath("what-helped.png"), fullPage: true });
});
