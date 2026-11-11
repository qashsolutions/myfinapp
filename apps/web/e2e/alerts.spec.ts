import { expect, type Locator, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/**
 * Alerts end to end (chunk 1.13): a type switched off, quiet hours, the most a day as one's own
 * number, pause and resume, all kept by the server across a reload; the push explainer comes
 * before the browser asks. The schedule the device sends is dates, types and keys only.
 * Real push delivery needs a push service on the network and is not walked here.
 */

/** A switch drawn as a track: tap its label, as a person taps the track. */
async function flip(toggle: Locator) {
  await toggle.locator("xpath=ancestor::label").click();
}

test("@phone alerts: a type off, quiet hours, own daily most, pause and resume, all kept", async ({
  page,
}) => {
  const schedules: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/alerts/schedule") && r.method() === "PUT")
      schedules.push(r.postData() ?? "");
  });
  await readyAccount(page, "alerts");
  await page.goto("/me/notifications");
  await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();

  // A type switched off.
  const recap = page.getByRole("switch", { name: "Weekly recap alerts" });
  if (!(await recap.isChecked())) await flip(recap);
  await expect(recap).toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/notifications/settings") && r.request().method() === "PUT",
  );
  await flip(recap);
  expect((await saved).ok()).toBe(true);
  await expect(recap).not.toBeChecked();

  // Quiet hours, and one's own most alerts a day.
  const from = page.getByLabel("Quiet from");
  await from.fill("21:30");
  await from.blur();
  await expect(page.getByText(/9:30\s?pm\s?–/i)).toBeVisible();
  await page.getByLabel("Your own most alerts a day, 1 to 20").fill("7");
  await page.getByLabel("Your own most alerts a day, 1 to 20").press("Enter");
  await expect(page.getByText("7 · extras go in one summary")).toBeVisible();

  // Pause for a week.
  await page.getByRole("button", { name: "1 week" }).click();
  await expect(page.getByText(/^Paused until /)).toBeVisible();

  // All of it is the server's now: a reload shows the same.
  await page.reload();
  await expect(page.getByRole("switch", { name: "Weekly recap alerts" })).not.toBeChecked();
  await expect(page.getByText(/9:30\s?pm\s?–/i)).toBeVisible();
  await expect(page.getByText("7 · extras go in one summary")).toBeVisible();
  await expect(page.getByText(/^Paused until /)).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Not paused")).toBeVisible();

  // Push: the explainer first, where the server has push set up (the Mac; not CI).
  const turnOn = page.getByRole("button", { name: "Turn on notifications" });
  if (await turnOn.isEnabled()) {
    await turnOn.click();
    const explain = page.getByRole("dialog", { name: "Stay on track" });
    await expect(explain).toBeVisible();
    await explain.getByRole("button", { name: "Not now" }).click();
    await expect(explain).toBeHidden();
  } else {
    await expect(page.getByText("Push isn't set up on the server yet.")).toBeVisible();
  }
  await expect(page.getByText("Security alerts are always on")).toBeVisible();

  // Whatever schedule was sent carries no amounts or names.
  for (const body of schedules) expect(body).not.toMatch(/cents|amount|merchant|account/i);
});
