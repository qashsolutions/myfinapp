import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  addPasskeyDevice,
  addSecurityKey,
  codeFor,
  codesSent,
  inviteLink,
  joinFromInvite,
  newEmail,
  ownAddress,
  passkeysOn,
  passkeysOnKey,
  readyAccount,
  setName,
} from "./helpers.ts";

/**
 * Sign-in and security end to end: a computer signed in by the phone (Link with your phone,
 * October 19, 2026; invariant 44), the devices list and recent activity, signing that computer
 * out, a second passkey added and removed, the email changed; and getting back in after losing
 * every passkey, let in by the household partner (October 30, 2026; invariant 74).
 */

const LOG = join(import.meta.dirname, ".output", "api.log");

/** Subjects of every email sent to this address so far. */
function subjectsTo(email: string): string[] {
  const log = readFileSync(LOG, "utf8");
  return log
    .split(`--- email to ${email}\nSubject: `)
    .slice(1)
    .map((s) => s.split("\n")[0] as string);
}

async function security(page: Page) {
  await page.goto("/me/security");
  await expect(page.getByRole("heading", { level: 1, name: "Security & backup" })).toBeVisible();
}

test("@phone sign-in: a computer signed in by the phone, signed out from it, a second passkey, a new email", async ({
  page,
  browser,
}) => {
  const email = await readyAccount(page, "secure");

  // The computer (no passkey) asks for a code; the phone types it and approves.
  const computer = await (await browser.newContext()).newPage();
  await ownAddress(computer);
  await computer.goto("/signin/phone");
  await expect(
    computer.getByRole("heading", { level: 1, name: "Sign in with your phone" }),
  ).toBeVisible();
  const code = (await computer.locator(".link__code [aria-hidden=true]").innerText()).trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/);

  await page.goto("/link");
  await page.getByLabel("Or type the code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Sign in on this computer?" })).toBeVisible();
  // Each side has its own made-up address here, so the phone warns: a different network.
  await expect(page.getByText("It's on a different network")).toBeVisible();
  const approve = page.getByRole("button", { name: /^Approve with/ });
  await expect(approve).toBeDisabled();
  await page.getByText("It's my computer, and I'm using it now").click();
  await approve.click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await expect(computer.getByRole("navigation", { name: "Primary" })).toBeVisible({
    timeout: 20_000,
  });

  // The phone sees the computer and the sign-in, and signs it out.
  await security(page);
  const signedIn = page.getByRole("list", { name: "Signed in now" });
  await expect(signedIn.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByText("Signed in").first()).toBeVisible();
  await signedIn.getByRole("button", { name: /^Sign out / }).click();
  await expect(signedIn.getByRole("listitem")).toHaveCount(1);
  await security(page); // recent activity is read when the screen opens
  await expect(page.getByText("Signed out a device").first()).toBeVisible();
  await computer.reload();
  await expect(computer.getByRole("navigation", { name: "Primary" })).toBeHidden();
  await expect(computer).toHaveURL(/\/(welcome|signin)/);

  // A second passkey, on a security key, then removed.
  await addSecurityKey(page);
  await page.getByRole("button", { name: "+ Add a passkey" }).click();
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(2);
  expect(await passkeysOnKey(page)).toBe(1); // the new one is on the key
  await page
    .getByRole("button", { name: /^Remove / })
    .last()
    .click();
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  await security(page);
  await expect(page.getByText("Passkey added").first()).toBeVisible();
  await expect(page.getByText("Passkey removed").first()).toBeVisible();

  // A new email: a code to the new address, then both addresses are told.
  const newAddress = newEmail("moved");
  await page.goto("/me/email");
  await page.getByLabel("New email").fill(newAddress);
  const before = codesSent(newAddress);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(`Code sent to ${newAddress}`).fill(await codeFor(newAddress, before));
  await page.getByRole("button", { name: "Verify and change" }).click();
  await expect(page.getByText(`Done. Your email is now ${newAddress}.`)).toBeVisible();
  await expect.poll(() => subjectsTo(email).length).toBeGreaterThan(1);
  await security(page);
  await expect(page.getByText("Email changed").first()).toBeVisible();
});

test("@phone lost every passkey: the household partner lets them back in with a code", async ({
  page,
  browser,
}) => {
  await readyAccount(page, "rescuer", "Connected");
  await setName(page, "Ana");
  const link = await inviteLink(page);
  const old = await (await browser.newContext()).newPage();
  const benEmail = await joinFromInvite(old, link, "Ana");
  await setName(old, "Ben");

  // Ben chooses Ana as the one who can let him back in.
  await old.goto("/me/household");
  await old.getByText("Let Ana help me get back in", { exact: true }).click();
  await expect(old.getByRole("switch", { name: "Let Ana help me get back in" })).toBeChecked();

  // A new device, no passkey: the email code, then the lock screen's way back.
  const ben = await (await browser.newContext()).newPage();
  await ownAddress(ben);
  await addPasskeyDevice(ben); // empty until the new passkey is made
  await ben.goto("/signin");
  await ben.getByLabel("Email address").fill(benEmail);
  const before = codesSent(benEmail);
  await ben.getByRole("button", { name: "Send code" }).click();
  await ben.getByLabel("6-digit code").fill(await codeFor(benEmail, before));
  await ben.getByRole("button", { name: "Continue" }).click();
  await ben.getByRole("button", { name: "Lost your passkeys?" }).click();
  await expect(ben.getByRole("heading", { level: 1, name: "Get back in" })).toBeVisible();
  await ben.getByRole("button", { name: "Ask my partner to let me in" }).click();
  await expect(ben.getByText("Read this code to your partner:")).toBeVisible();
  const code = (await ben.locator(".recover__code").innerText()).replace(/\D/g, "");
  expect(code).toHaveLength(6);

  // Ana types it in; a wrong one first.
  await page.goto("/me/household");
  const ask = page.getByRole("alert", { name: "Ben asked for help getting back in" });
  await expect(ask).toBeVisible({ timeout: 20_000 });
  const wrong = code === "000000" ? "111111" : "000000";
  await ask.getByLabel("Their code").fill(wrong);
  await ask.getByRole("button").click();
  await expect(page.getByText(/That code doesn't match/)).toBeVisible();
  await ask.getByLabel("Their code").fill(code);
  await ask.getByRole("button").click();
  await expect(ask).toBeHidden();

  // Ben makes a new passkey; the old device is signed out, and the old passkey is gone.
  await expect(ben.getByRole("heading", { level: 1, name: "You're ready" })).toBeVisible({
    timeout: 20_000,
  });
  await ben.getByRole("button", { name: "Create a new passkey" }).click();
  await expect(ben.getByRole("navigation", { name: "Primary" })).toBeVisible();
  expect(await passkeysOn(ben)).toBe(1);
  await security(ben);
  await expect(ben.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  await old.reload();
  await expect(old.getByRole("navigation", { name: "Primary" })).toBeHidden();
});
