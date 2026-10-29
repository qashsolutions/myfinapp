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
  // The bar marks "Tell me at" and the plan's end (October 29, 2026).
  await expect(groceries.getByRole("progressbar")).toHaveAttribute(
    "aria-valuetext",
    /· (Tell me|Close) at 90% · Plan$/,
  );
  await page.screenshot({ path: test.info().outputPath("budget-close.png"), fullPage: true });

  // "Don't alert me for this one": the line keeps its word, and the next schedule has no item.
  const sent = bodies.length;
  await page.getByRole("button", { name: "Adjust budget alerts" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust budget alerts" });
  const groceriesAlert = adjust.getByRole("switch", { name: "Alert me for Groceries" });
  await expect(groceriesAlert).toBeChecked();
  await adjust.getByText("Alert me for Groceries", { exact: true }).click();
  await expect(groceriesAlert).not.toBeChecked();
  await adjust.getByRole("button", { name: "Done" }).click();
  await expect(groceries).toContainText("Close");
  await expect
    .poll(() => bodies.slice(sent).some((b) => !b.includes("budget_pace")), { timeout: 20_000 })
    .toBe(true);
});

/** Where the owner's screenshots of each changed screen go (kept; the owner looks at them). */
const SHOTS = process.env.E2E_SHOTS_DIR;

/** The same screen at phone and computer width, light and dark, into SHOTS. */
async function shoot(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (!SHOTS) return;
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
}

/** A second person: their own browser context and passkey, joins by code, reaches the target. */
async function memberReachesTarget(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  code: string,
  name: string,
  choices: string[],
): Promise<void> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await readyAccount(page, name.toLowerCase());
  await page.goto(`/groups/join?code=${code}`);
  await page.getByRole("radio", { name: "$500.00" }).click();
  const field = page.getByLabel("Your name, as members will see it");
  if (await field.isVisible()) await field.fill(name);
  await page.getByRole("button", { name: /^Join as/ }).click();
  await page.getByRole("link", { name: "Log a deposit" }).click();
  await page.getByLabel("Other amount").fill("500");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("img", { name: "100 percent" })).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await showChallenges(page);
  await page.getByRole("link", { name: /savings challenge/ }).click();
  const card = page.getByRole("region", { name: "What helped" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  for (const c of choices)
    await card
      .getByRole("group", { name: "What helped you" })
      .getByText(c, { exact: true })
      .click();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Saved. Thanks for sharing.");
  await ctx.close();
}

test("up to five picks, and once two others answered the totals are a ranked chart with my picks marked", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await readyAccount(page, "helpedfive");
  await page.goto("/goals");
  await showChallenges(page);
  await page.getByRole("link", { name: "Start a challenge" }).click();
  await page.getByRole("radio", { name: "$500.00" }).click();
  const name = page.getByLabel("Your name, as members will see it");
  if (await name.isVisible()) await name.fill("Nia");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await page.getByRole("button", { name: "Invite" }).click();
  const code = ((await page.locator(".invite-code").textContent()) ?? "").replace(
    "Invite code: ",
    "",
  );
  expect(code).toMatch(/^STK-[A-Z0-9]{4}$/);
  await page.keyboard.press("Escape");

  await memberReachesTarget(browser, baseURL as string, code, "Dev", [
    "Packed lunch",
    "Cooked at home",
    "Shopped with a list",
  ]);
  await memberReachesTarget(browser, baseURL as string, code, "Sam", [
    "Packed lunch",
    "No-spend days",
  ]);

  await page.getByRole("link", { name: "Log a deposit" }).click();
  await page.getByLabel("Other amount").fill("500");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("img", { name: "100 percent" })).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await showChallenges(page);
  await page.getByRole("link", { name: /savings challenge/ }).click();
  const card = page.getByRole("region", { name: "What helped" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Two others answered: the chart shows before I answer, most said first
  await expect(card.getByRole("img", { name: /What helped the group/ })).toHaveAccessibleName(
    "What helped the group: 2 of 2 said Packed lunch, 1 of 2 said Cooked at home, 1 of 2 said No-spend days, 1 of 2 said Shopped with a list",
  );
  // Five picks fit; a sixth waits
  for (const c of [
    "Packed lunch",
    "Cooked at home",
    "Set money aside on payday",
    "Waited a day before buying",
    "Used cash for treats",
  ])
    await card
      .getByRole("group", { name: "What helped you" })
      .getByText(c, { exact: true })
      .click();
  await expect(card.getByRole("checkbox", { name: "Shopped with a list" })).toBeDisabled();
  const saved = page.waitForRequest(
    (r) => r.method() === "PUT" && /\/api\/groups\/[^/]+\/helped$/.test(new URL(r.url()).pathname),
  );
  await card.getByRole("button", { name: "Save" }).click();
  expect(JSON.parse((await saved).postData() ?? "{}").choices).toHaveLength(5);
  await expect(card.getByRole("img", { name: /What helped the group/ })).toHaveAccessibleName(
    /^What helped the group: 3 of 3 said Packed lunch \(your pick\), 2 of 3 said Cooked at home \(your pick\)/,
  );
  await expect(card).toContainText("✓ Your picks");
  // A fresh load: no celebration over the picture
  await page.reload();
  await expect(page.getByRole("region", { name: "What helped" })).toContainText("Your picks");
  await shoot(page, "H-what-helped");
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
