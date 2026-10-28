import { expect, test } from "@playwright/test";
import { readyAccount, signUp } from "./helpers.ts";

/**
 * A returning person (October 28, 2026): they deleted their account, then sign up again with the
 * same email. The trial was used on that inbox, so /start says so and leads to the plans, and a
 * plan can be bought (up to Stripe's page, which is not followed).
 */
test("signing up again with the same email shows the plans and reaches checkout", async ({
  page,
  context,
}) => {
  const email = await readyAccount(page, "returning");
  await page.goto("/me");
  await page.getByRole("button", { name: "Delete account" }).click();
  await page.getByText("I understand this permanently deletes my account and its data.").click();
  await page.getByRole("button", { name: "Delete forever" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your account is deleted" }),
  ).toBeVisible();

  // The same email again, on a fresh tab with its own passkey device.
  const again = await context.newPage();
  await signUp(again, email);
  await expect(again.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(again.getByText(/Your free trial was already used on this email/)).toBeVisible();
  // Other screens lead back here rather than to a dead end.
  await again.goto("/budget");
  await expect(again.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();

  await again.getByRole("link", { name: "See plans" }).click();
  const priv = again.getByRole("article", { name: "Private" });
  await expect(priv).toBeVisible();
  const choose = priv.getByRole("button", { name: "Choose Private" });
  await expect(choose).toBeVisible();
  // Download and delete stay open too.
  await again.goto("/me/data");
  await expect(again.getByRole("button", { name: /Download/ }).first()).toBeVisible();
  await again.goto("/me/plan");

  // Payments are open only where Stripe test keys are set (the Mac); CI has none, so the plans
  // are shown and the purchase stops there.
  if (!(await choose.isEnabled())) return;
  await again.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>Stripe</title>" }),
  );
  await choose.click();
  const sheet = again.getByRole("dialog", { name: "Before you subscribe" });
  await sheet.getByRole("checkbox").check();
  const checkout = again.waitForResponse("**/api/billing/checkout");
  await sheet.getByRole("button", { name: "Continue to secure payment" }).click();
  expect((await checkout).status()).toBe(200);
  await again.waitForURL(/^https:\/\/checkout\.stripe\.com\//);
});
