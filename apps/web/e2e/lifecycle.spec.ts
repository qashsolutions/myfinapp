import { expect, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

test("budget your way, a jar, export, sign out and back in with the passkey, delete", async ({
  page,
}) => {
  await readyAccount(page, "life");

  // Budget: take-home, then your own split instead of 50/30/20.
  await page.goto("/budget");
  await page
    .getByLabel(/Each paycheck|paycheck/i)
    .first()
    .fill("2600");
  await page.getByRole("radio", { name: "Twice a month" }).check();
  await page.getByLabel("Next payday").fill("2026-10-31");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Pick a budget style" })).toBeVisible();
  await page.getByLabel("Needs, percent of pay").fill("60");
  await page.getByLabel("Wants, percent of pay").fill("20");
  await expect(page.getByText("Needs $3,120.00")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Needs · 60%")).toBeVisible();

  // A jar from the sentence builder, and a first deposit.
  await page.goto("/goals/new");
  await expect(page.getByRole("heading", { level: 1, name: "New goal" })).toBeVisible();
  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page.getByRole("img", { name: "0 percent" })).toBeVisible();
  await page.getByLabel("Other amount").fill("100");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("img", { name: /^[1-9]\d* percent$/ })).toBeVisible();

  // Export: one passkey check, then a ZIP built on the device.
  await page.goto("/me/data");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all my data" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.zip$/);

  // Sign out, then back in with one passkey tap.
  await page.goto("/me");
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  await page.getByRole("button", { name: /^Continue with/ }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  // Delete: two taps from Me, a box to tick, a passkey check.
  await page.goto("/me");
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Delete account" })).toBeVisible();
  await page.getByText("I understand this permanently deletes my account and its data.").click();
  await page.getByRole("button", { name: "Delete forever" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your account is deleted" }),
  ).toBeVisible();
});
