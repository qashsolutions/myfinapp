import { expect, type Page, test } from "@playwright/test";
import { addPasskeyDevice, readyAccount, signInHere, syncPasskeys } from "./helpers.ts";

/**
 * Streaks, Your path and milestones end to end (November 20, 2026; invariant 94). The browser's
 * clock is moved a week at a time, never the server's: each deposit lands in its own week, as it
 * would for a person over weeks. Before each jump the page leaves the app, so its idle timer
 * never reads the jump as weeks without activity.
 *
 * Positive: a deposit a week builds the run, the week is celebrated once, Home leads with it,
 * Your path and milestones read the same data. Negative: a missed week is a Fresh start (plain),
 * a rest week keeps the run and survives a reload, Pause holds everything, Start again answers
 * the next miss. Nothing about any of it is ever sent.
 */

function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

/** Tuesday noon, `weeksAgo` weeks before this week (0 = this week). */
function tuesday(weeksAgo: number): Date {
  const d = mondayOf(new Date());
  d.setDate(d.getDate() - 7 * weeksAgo + 1);
  return d;
}

async function setDay(page: Page, when: Date): Promise<void> {
  await page.goto("about:blank");
  await page.clock.setFixedTime(when);
}

/** Every request body the page sends, to check nothing about streaks leaves the device. */
function bodies(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && !new URL(r.url()).pathname.startsWith("/api/auth/"))
      out.push(`${new URL(r.url()).pathname} ${r.postData() ?? ""}`);
  });
  return out;
}

async function newJar(page: Page): Promise<string> {
  await page.goto("/goals/new");
  await expect(page.getByRole("heading", { level: 1, name: "New goal" })).toBeVisible();
  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Logs a deposit today and waits until the jar's total shows it (the write is in). */
async function deposit(page: Page, jar: string, dollars: string, total: string): Promise<void> {
  await page.goto(jar);
  await page.getByLabel("Other amount").fill(dollars);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("region", { name: "Progress" })).toContainText(total);
}

/** Goals → Streaks: the tab on a phone; from 900px Streaks sits under Jars. */
async function openStreaks(page: Page): Promise<void> {
  await page.goto("/goals?tab=streaks");
  await expect(page.getByRole("heading", { level: 1, name: "Goals" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Streaks summary" })).toBeVisible();
}

/** With SHOTS_PREFIX set (a local run only), full-page shots in light and dark for review. */
async function shots(page: Page, name: string): Promise<void> {
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

function noStreakData(sent: string[]): void {
  for (const b of sent) expect(b).not.toMatch(/streak|milestone|rest week|path\.(layout|reached)/i);
}

test("@phone streaks build a week at a time: celebrated once, Home leads, path and milestones follow", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = bodies(page);
  await readyAccount(page, "sx-up");

  await setDay(page, tuesday(2));
  const jar = await newJar(page);
  await deposit(page, jar, "20", "$20.00");
  await setDay(page, tuesday(1));
  await deposit(page, jar, "20", "$40.00");
  await setDay(page, tuesday(0));
  await deposit(page, jar, "20", "$60.00");

  // Home: the streak is the second card, right after This month, and the third week in a row
  // is celebrated as Home reads it.
  await page.goto("/");
  await expect(page.locator(".moment-toast").filter({ hasText: /3 weeks/ })).toBeVisible({
    timeout: 20_000,
  });
  const card = page.getByRole("link", { name: "Streaks, open Streaks" });
  await expect(card).toContainText("3 weeks");
  await expect(card).toContainText("Set aside · keep it going");
  await expect(card.getByRole("list", { name: "This week" })).toContainText("Set aside on T");
  await shots(page, "home");

  await card.click();
  await expect(page.getByRole("region", { name: "Set aside" })).toContainText("3 weeks");
  await expect(page.getByRole("region", { name: "Streaks summary" })).toContainText("Steady");
  await shots(page, "streaks-tab");

  // Your path: the summary, then Adjust skips a step, which stays skipped after a reload.
  await page.getByRole("link", { name: "Your path, open Your path" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your path" })).toBeVisible();
  const where = page.getByRole("region", { name: "Where you are" });
  await expect(where).toContainText(/\d of 7 done/);
  await shots(page, "path");
  await page.getByRole("button", { name: "Adjust" }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust your path" });
  await shots(page, "path-adjust");
  await sheet.getByRole("checkbox", { name: "Show this step" }).first().uncheck();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(where).toContainText(/\d of 6 done/);
  await page.reload();
  await expect(page.getByRole("region", { name: "Where you are" })).toContainText(/\d of 6 done/);
  await expect(page.getByText("A common order, not advice.", { exact: false })).toBeVisible();

  // Milestones: the first jar is reached, with what's still to go dashed below.
  await page.goto("/milestones");
  await expect(page.getByRole("region", { name: "So far" })).toContainText(/\d+ reached/);
  // Reached first, then the closest few; the rest folded under More milestones.
  await expect(page.getByRole("list", { name: "Reached · 1" })).toContainText("First jar");
  const shelf = page.getByRole("main");
  await expect(shelf).toContainText("Reached: First jar");
  await expect(shelf).toContainText("Not yet: 12-week streak");
  await expect(shelf).toContainText("9 weeks to go");
  await shots(page, "milestones");

  noStreakData(sent);
});

test("@phone a missed week: Fresh start, a rest week keeps the run, pause holds, Start again answers the next", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = bodies(page);
  await readyAccount(page, "sx-miss");

  // Deposits three and two weeks ago; nothing last week; nothing yet this week.
  await setDay(page, tuesday(3));
  const jar = await newJar(page);
  await deposit(page, jar, "15", "$15.00");
  await setDay(page, tuesday(2));
  await deposit(page, jar, "15", "$30.00");
  await setDay(page, tuesday(0));

  await openStreaks(page);
  const aside = page.getByRole("region", { name: "Set aside" });
  await expect(aside).toContainText("Fresh start");
  // Never red: a missed week is plain.
  await expect(aside.locator(".word")).toHaveClass(/word--plain/);
  await expect(aside).toContainText("Your best stays 2 weeks.");
  await shots(page, "fresh-start");

  // A rest week keeps the run of 2; it stays after a reload.
  await aside.getByRole("button", { name: "Use a rest week · keep your 2" }).click();
  await expect(aside).not.toContainText("Fresh start");
  await expect(aside.locator(".word")).toHaveText("2 weeks");
  await page.reload();
  await expect(page.getByRole("region", { name: "Set aside" }).locator(".word")).toHaveText(
    "2 weeks",
  );

  // Pause holds everything, on the tab and on Home; Resume brings it back.
  await page.getByRole("button", { name: "Pause streaks" }).click();
  await expect(page.getByRole("region", { name: "Streaks summary" })).toContainText("Paused");
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Streaks, open Streaks" })).toContainText("Paused");
  await openStreaks(page);
  await page.getByRole("button", { name: "Resume streaks" }).click();
  await expect(page.getByRole("region", { name: "Streaks summary" })).not.toContainText("Paused");

  // A week later with no deposit: Fresh start again; Start again answers it without a rest.
  await setDay(page, tuesday(-1));
  await openStreaks(page);
  const next = page.getByRole("region", { name: "Set aside" });
  await expect(next).toContainText("Fresh start");
  await next.getByRole("button", { name: "Start again this week" }).click();
  await expect(next).not.toContainText("Fresh start");
  await expect(next.locator(".word")).toHaveText("Start");
  await expect(next).toContainText("Best 2 weeks");

  // The next deposit starts a new run at 1.
  await deposit(page, jar, "15", "$45.00");
  await openStreaks(page);
  await expect(page.getByRole("region", { name: "Set aside" }).locator(".word")).toHaveText(
    "1 week",
  );

  noStreakData(sent);
});

test("@phone getting around: search, back buttons, the keyboard, and working offline", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await readyAccount(page, "sx-nav");
  await setDay(page, tuesday(1));
  const jar = await newJar(page);
  await deposit(page, jar, "10", "$10.00");
  await setDay(page, tuesday(0));
  await deposit(page, jar, "10", "$20.00");

  // Search finds each place by everyday words.
  await page.goto("/");
  for (const [words, heading] of [
    ["streak", "Goals"],
    ["badges", "Milestones"],
    ["next step", "Your path"],
  ] as const) {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const box = page.getByRole("dialog", { name: "Search" }).getByRole("combobox", {
      name: "Search Qash",
    });
    await box.fill(words);
    await box.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }

  // Back from Milestones and Your path lands on Goals → Streaks.
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("region", { name: "Streaks summary" })).toBeVisible();
  await page.getByRole("link", { name: "Milestones, open Milestones" }).click();
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByRole("region", { name: "Set aside" })).toContainText("2 weeks");

  // The keyboard: Adjust opens without a text box in the way; Escape leaves without saving.
  await page.goto("/path");
  await page.getByRole("button", { name: "Adjust" }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust your path" });
  await expect(sheet.getByRole("textbox")).toHaveCount(0);
  await sheet.getByRole("checkbox", { name: "Show this step" }).first().uncheck();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("region", { name: "Where you are" })).toContainText(/of 7 done/);

  // Offline: everything here is on this device, so it all still opens.
  await page.goto("/goals?tab=streaks");
  await expect(page.getByRole("region", { name: "Set aside" })).toContainText("2 weeks");
  await page.context().setOffline(true);
  await page.getByRole("link", { name: "Your path, open Your path" }).click();
  await expect(page.getByRole("region", { name: "Where you are" })).toBeVisible();
  await page.getByRole("link", { name: "Back" }).click();
  await page.getByRole("link", { name: "Milestones, open Milestones" }).click();
  await expect(page.getByRole("list", { name: "Reached · 1" })).toContainText("First jar");
  await page.context().setOffline(false);
});

test("@phone a second device restored from the backup has the same streaks, path and milestones", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const sent = bodies(page);
  await readyAccount(page, "sx-restore");

  // Device one: deposits three and two weeks ago, none last week, then a rest week keeps 2.
  await setDay(page, tuesday(3));
  const jar = await newJar(page);
  await deposit(page, jar, "25", "$25.00");
  await setDay(page, tuesday(2));
  await deposit(page, jar, "25", "$50.00");
  await setDay(page, tuesday(0));
  await openStreaks(page);
  const aside = page.getByRole("region", { name: "Set aside" });
  await aside.getByRole("button", { name: "Use a rest week · keep your 2" }).click();
  await expect(aside.locator(".word")).toHaveText("2 weeks");

  // Your path: Starter fund renamed, Get set up skipped.
  await page.goto("/path");
  await page.getByRole("button", { name: "Adjust" }).click();
  const adjust = page.getByRole("dialog", { name: "Adjust your path" });
  await adjust.getByRole("checkbox", { name: "Show this step" }).first().uncheck();
  await adjust.getByRole("button", { name: "Rename Starter fund" }).click();
  await adjust.getByRole("textbox", { name: "Name for Starter fund" }).fill("Rainy day $1k");
  await adjust.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "Where you are" })).toContainText(/of 6 done/);

  // Milestones read once here: First jar is kept with today's day.
  await page.goto("/milestones");
  await expect(page.getByRole("list", { name: "Reached · 1" })).toContainText("First jar");

  // Backup on; the recovery key is shown once.
  await page.goto("/me/security");
  await page.getByRole("button", { name: "Turn on encrypted backup" }).click();
  const keySheet = page.getByRole("dialog", { name: "Your recovery key" });
  const recoveryKey = (await keySheet.locator(".invite-code").innerText())
    .replace("Recovery key:", "")
    .trim();
  await keySheet.getByRole("button", { name: "I've saved it" }).click();
  await expect(page.getByText(/Last backup: /)).toBeVisible();

  // Device two, the same week: sign in with the synced passkey, restore with the key.
  const second = await (await browser.newContext()).newPage();
  const sentTwo = bodies(second);
  await second.clock.setFixedTime(tuesday(0));
  await addPasskeyDevice(second);
  await syncPasskeys(page, second);
  await signInHere(second);
  await expect(second.getByText("Your backup is ready for this device")).toBeVisible();
  await second.getByRole("button", { name: "Restore", exact: true }).click();
  await second.getByLabel("Recovery key").fill(recoveryKey);
  await second.getByRole("button", { name: "Unlock with the recovery key" }).click();
  await expect(second.getByText(/^Restored \d+ items?\. This device now syncs\./)).toBeVisible();

  // The run with its rest week, never a Fresh start, and the kept best.
  await openStreaks(second);
  const asideTwo = second.getByRole("region", { name: "Set aside" });
  await expect(asideTwo.locator(".word")).toHaveText("2 weeks");
  await expect(asideTwo).not.toContainText("Fresh start");
  await expect(asideTwo.getByRole("img")).toHaveAccessibleName(/2 kept, 1 rest/);
  await expect(asideTwo).toContainText("Best 2 weeks");

  // Your path in the same order, with the same name and the same skip.
  await second.goto("/path");
  await expect(second.getByRole("region", { name: "Where you are" })).toContainText(/of 6 done/);
  await expect(second.getByText("Rainy day $1k")).toBeVisible();

  // Milestones: First jar already reached, and not celebrated again on this device.
  await second.goto("/milestones");
  await expect(second.getByRole("list", { name: "Reached · 1" })).toContainText("First jar");
  await second.waitForTimeout(1500);
  await expect(second.locator(".moment-toast").filter({ hasText: /milestone/i })).toHaveCount(0);

  // Only ciphertext ever left either device.
  noStreakData(sent);
  noStreakData(sentTwo);
  for (const b of [...sent, ...sentTwo]) expect(b).not.toContain("Rainy day");
});
