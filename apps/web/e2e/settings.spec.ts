import { expect, type Locator, test } from "@playwright/test";
import { ownAddress, readyAccount } from "./helpers.ts";

/**
 * Look & feel and finding a setting (chunks 1.1, 2.2; October 18–19, 2026): settings search in
 * everyday words opens the right screen, a look picked applies at once and stays after a reload,
 * dark mode and Simple layout switch the whole app; and the public /install page that the
 * website's "Install the app" opens works signed out.
 */

async function flip(toggle: Locator) {
  await toggle.locator("xpath=ancestor::label").click();
}

test("@phone settings: search finds it, a look and dark mode and Simple layout apply and stay", async ({
  page,
}) => {
  await readyAccount(page, "settings");
  const html = page.locator("html");

  // Everyday words find the setting and open its screen.
  await page.goto("/me");
  await page.getByRole("searchbox", { name: "Search settings" }).fill("plain larger");
  const results = page.getByRole("list", { name: "Search results" });
  await results.getByText("Simple layout").click();
  await expect(page.getByRole("heading", { level: 1, name: "Look & feel" })).toBeVisible();

  // A look: applied at once, kept after a reload.
  const retro = page.getByRole("radio", { name: /Retro/ });
  await retro.locator("xpath=ancestor::label").click();
  await expect(retro).toBeChecked();
  const look = await html.getAttribute("data-look");
  expect(look).not.toBe("modern");

  // Dark mode (Match system off first) and Simple layout, on the whole app.
  const system = page.getByRole("switch", { name: "Match system" });
  if (await system.isChecked()) await flip(system);
  await flip(page.getByRole("switch", { name: "Dark mode" }));
  await expect(html).toHaveAttribute("data-mode", "dark");
  await flip(page.getByRole("switch", { name: "Simple layout" }));
  await expect(html).toHaveAttribute("data-simple", "1");

  await page.reload();
  await expect(html).toHaveAttribute("data-look", look as string);
  await expect(html).toHaveAttribute("data-mode", "dark");
  await expect(html).toHaveAttribute("data-simple", "1");
  await page.goto("/");
  await expect(html).toHaveAttribute("data-simple", "1");
});

test("@phone the install page works signed out, from the website's button", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await ownAddress(page);
  await page.goto("/install");
  await expect(
    page.getByRole("heading", { level: 1, name: /Install Qash|You're all set/ }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
});
