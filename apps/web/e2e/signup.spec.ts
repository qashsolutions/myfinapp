import { expect, test } from "@playwright/test";
import { newEmail, signUp } from "./helpers.ts";

test("@phone a new person signs up with an email code and a passkey, picks a trial, lands on Home", async ({
  page,
}) => {
  await signUp(page, newEmail("signup"));
  // No lasting Free plan: the trial comes first, 3 days on either plan, no card.
  await expect(page.getByRole("heading", { name: "Try Qash free" })).toBeVisible();
  await expect(page.getByText("Free for 3 days")).toHaveCount(2);
  await page.getByRole("radio", { name: /Private/ }).check();
  await page.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Make Qash yours" })).toBeVisible();
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect(page.getByText(/Private trial · \d days? left/)).toBeVisible();
});
