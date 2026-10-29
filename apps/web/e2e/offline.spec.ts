import { expect, test } from "@playwright/test";
import {
  addPasskeyDevice,
  codeFor,
  codesSent,
  newEmail,
  ownAddress,
  readyAccount,
} from "./helpers.ts";

/**
 * Offline and the way back in (defect round, October 29, 2026; invariants 36 and 37).
 *
 * The dev server has no service worker, so "the network is gone" is the API unreachable (the
 * installed app's worker serves the page itself) plus the browser offline once the page is up.
 */
test("opened with no network, the app shows the lock screen and unlocks on this device @phone", async ({
  page,
  context,
}) => {
  await readyAccount(page, "offline");
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await context.setOffline(true);
  await expect(
    page.getByText(/You're offline\. Unlock to use what's on this device/),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Unlock with/ }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByText("You're offline", { exact: true })).toBeVisible();

  // Back online: the session is asked again and the server's word wins.
  await page.unroute("**/api/**");
  const asked = page.waitForRequest((r) => r.url().endsWith("/api/auth/session"));
  await context.setOffline(false);
  await asked;
  await expect(page.getByText("You're offline", { exact: true })).toBeHidden();
});

test("a household invite opened signed out lands on the invite after sign-up, key and all", async ({
  page,
}) => {
  const KEY = "e2eHouseholdKeyStaysOnTheDevice0123456789";
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.url()} ${r.postData() ?? ""}`));
  await ownAddress(page);
  await addPasskeyDevice(page);
  await page.goto(`/household/join?code=HH-ABCDEF#k=${KEY}`);
  await page.getByRole("link", { name: "Get started" }).click();
  const email = newEmail("return");
  await page.getByLabel("Email address").fill(email);
  const before = codesSent(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("6-digit code").fill(await codeFor(email, before));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await page
    .getByRole("button", { name: /Continue|Go|Start|Done/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Join a household" })).toBeVisible();
  await expect(page.getByText(/This link is missing its key/)).toBeHidden();
  expect(page.url()).toContain(`#k=${KEY}`);
  for (const r of seen.filter((s) => s.includes("/api/"))) expect(r).not.toContain(KEY);
});
