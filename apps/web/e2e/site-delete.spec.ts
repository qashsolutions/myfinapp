import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/**
 * The website's public deletion page end to end (chunk 1W, W.3; store requirement): someone
 * without the app asks for a code at their email, a wrong code is refused with the tries left,
 * the right one deletes the account, and the app on their device then erases its copy and
 * says so.
 */

const LOG = join(import.meta.dirname, ".output", "api.log");
const SITE = `http://localhost:${process.env.E2E_SITE_PORT ?? "4322"}`;
const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "8100"}`;

function deletionCode(email: string): string | null {
  const re = new RegExp(
    `--- email to ${email.replace(/[.+]/g, "\\$&")}\\nSubject: Confirm deleting your Qash account: (\\d{6})`,
    "g",
  );
  const codes = [...readFileSync(LOG, "utf8").matchAll(re)].map((m) => m[1] as string);
  return codes.at(-1) ?? null;
}

test("@phone the website's deletion page: a code to the email, a wrong one refused, the account deleted", async ({
  page,
  browser,
}) => {
  const email = await readyAccount(page, "site-delete");

  const site = await (await browser.newContext()).newPage();
  // Its own made-up client address, as every app page here has (the per-address code limits),
  // added on the way out so the browser's cross-origin rules see the page's real request.
  const n = () => 1 + Math.floor(Math.random() * 250);
  const ip = `10.${n()}.${n()}.${n()}`;
  await site.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ip } }),
  );
  await site.goto(`${SITE}/delete-account`);
  await site.getByLabel("Your account email").fill(email);
  await site.getByRole("button", { name: "Email me a confirmation code" }).click();
  await expect(site.getByLabel("Confirmation code", { exact: true })).toBeVisible();
  await expect.poll(() => deletionCode(email)).not.toBeNull();
  const code = deletionCode(email) as string;

  await site
    .getByLabel("Confirmation code", { exact: true })
    .fill(code === "000000" ? "111111" : "000000");
  await site.getByRole("button", { name: "Delete my account" }).click();
  await expect(site.getByText(/^That code didn't match\. \d tries left\./)).toBeVisible();
  await site.getByLabel("Confirmation code", { exact: true }).fill(code);
  await site.getByRole("button", { name: "Delete my account" }).click();
  await expect(site.getByText(/^Your account is being deleted\./)).toBeVisible();

  // The app on the person's device learns it on its next open.
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Your account is deleted" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/deleted$/);
  // The device's copy is erased: its database is gone.
  const left = await page.evaluate(
    async () => (await indexedDB.databases()).filter((d) => d.name?.startsWith("stackd-")).length,
  );
  expect(left).toBe(0);
});
