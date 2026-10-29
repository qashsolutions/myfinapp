import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/** The plan lifecycle's closure, 7 days after a plan ended, without waiting the week. */
function closeForPlanEnd(email: string): void {
  execFileSync("sh", [join(import.meta.dirname, "close-account.sh"), email], {
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });
}

/**
 * Invariant 57 (October 29, 2026): an account that closed when its plan ended, opened twice
 * after the closure. The server says so once; every open after that still leads to the data
 * kept on this device, and Welcome never offers the closed account's passkey.
 */
test("a closed account, opened a second time, leads to its kept data, not a dead sign-in", async ({
  page,
}) => {
  const email = await readyAccount(page, "kept");
  closeForPlanEnd(email);

  // First open after the closure: the server reports it, and the device keeps its data.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your data is safe here" }),
  ).toBeVisible();

  // Second open: the server has nothing more to say, and the device still leads to the data.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your data is safe here" }),
  ).toBeVisible();

  // Welcome (Start again) says the account closed; no passkey sign-in for it.
  await page.getByRole("button", { name: "Start again with Qash" }).click();
  const closed = page.getByRole("region", { name: /^Your account closed on .+\. Your data is/ });
  await expect(closed).toBeVisible();
  await expect(page.getByText(/Welcome back/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Continue with|Sign in with/ })).toHaveCount(0);
  await expect(page.getByText(/No Qash passkey/)).toHaveCount(0);
  await closed.getByRole("link", { name: "See my data" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your data is safe here" }),
  ).toBeVisible();
});
