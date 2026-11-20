import { expect, type Page, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

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

  await card.click();
  await expect(page.getByRole("region", { name: "Set aside" })).toContainText("3 weeks");
  await expect(page.getByRole("region", { name: "Streaks summary" })).toContainText("Steady");

  // Your path: the summary, then Adjust skips a step, which stays skipped after a reload.
  await page.getByRole("link", { name: "Your path, open Your path" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your path" })).toBeVisible();
  const where = page.getByRole("region", { name: "Where you are" });
  await expect(where).toContainText(/\d of 7 done/);
  await page.getByRole("button", { name: "Adjust" }).click();
  const sheet = page.getByRole("dialog", { name: "Adjust your path" });
  await sheet.getByRole("checkbox", { name: "Show this step" }).first().uncheck();
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(where).toContainText(/\d of 6 done/);
  await page.reload();
  await expect(page.getByRole("region", { name: "Where you are" })).toContainText(/\d of 6 done/);
  await expect(page.getByText("A common order, not advice.", { exact: false })).toBeVisible();

  // Milestones: the first jar is reached, with what's still to go dashed below.
  await page.goto("/milestones");
  await expect(page.getByRole("region", { name: "So far" })).toContainText(/\d+ reached/);
  const shelf = page.getByRole("list", { name: "Milestones" });
  await expect(shelf).toContainText("Reached: First jar");
  await expect(shelf).toContainText("Not yet: 12-week streak");
  await expect(shelf).toContainText("9 weeks to go");

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
