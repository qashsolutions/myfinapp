import { expect, type Page, test } from "@playwright/test";
import {
  addPasskeyDevice,
  readyAccount,
  signInHere,
  syncPasskeys,
  wipeDeviceData,
} from "./helpers.ts";

/**
 * Encrypted backup end to end (chunk 1.16; invariant 24): turned on with the passkey, the
 * recovery key shown once, a second device restored with that key, a change there reaching the
 * first device, the first device's data erased and brought back with its passkey (PRF), and
 * backup turned off. Only ciphertext may leave: no request body ever carries the jar's name.
 *
 * Chrome's virtual authenticator keeps a passkey's PRF secret to itself (a copied passkey signs
 * in but derives a different PRF output), so "Unlock with Touch ID" is walked on the device that
 * made the passkey, and the synced second device uses the recovery key. A copy also carries on
 * the signature counter, which real synced passkeys keep at 0, so the first device's passkey is
 * not asked again once the second has used it (the step-up to turn backup off is still fresh).
 */

const JAR = "Kayak"; // a jar name nothing else in the app uses

async function newJar(page: Page) {
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Change what it's for" }).click();
  await page.getByLabel("Or name your own").fill(JAR);
  await page.getByRole("button", { name: "Use this" }).click();
  await page.getByRole("button", { name: "Create jar" }).click();
  await page.getByLabel("Other amount").fill("100");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByRole("img", { name: /^[1-9]\d* percent$/ })).toBeVisible();
}

function watchBodies(page: Page, bodies: string[]) {
  page.on("request", (r) => {
    if (r.url().includes("/api/")) bodies.push(r.postData() ?? "");
  });
}

test("@phone backup: on with the passkey, restored with the recovery key and the passkey, kept in sync, then off", async ({
  page,
  browser,
}) => {
  const sent: string[] = [];
  watchBodies(page, sent);
  await readyAccount(page, "backup");
  await newJar(page);

  // Turn it on: one passkey check, then the recovery key, shown once.
  await page.goto("/me/security");
  await page.getByRole("button", { name: "Turn on encrypted backup" }).click();
  const sheet = page.getByRole("dialog", { name: "Your recovery key" });
  const recoveryKey = (await sheet.locator(".invite-code").innerText())
    .replace("Recovery key:", "")
    .trim();
  expect(recoveryKey).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){7}$/);
  await sheet.getByRole("button", { name: "I've saved it" }).click();
  await expect(page.getByText(/^On\./)).toBeVisible();
  await expect(page.getByText(/Last backup: /)).toBeVisible();

  // The first device's data erased; its passkey brings everything back.
  await wipeDeviceData(page);
  await expect(page.getByText("Your backup is ready for this device")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: /^Unlock with (?!the recovery key)/ }).click();
  await expect(page.getByText(/^Restored \d+ items?\. This device now syncs\./)).toBeVisible();
  await page.goto("/goals");
  await expect(page.getByText(JAR).first()).toBeVisible();
  await expect(page.getByText("$100").first()).toBeVisible();

  // A second device (the passkey synced to it): Home offers the backup; a wrong recovery key
  // is refused, the right one opens it, typed in lower case.
  const second = await (await browser.newContext()).newPage();
  watchBodies(second, sent);
  await addPasskeyDevice(second);
  await syncPasskeys(page, second);
  await signInHere(second);
  await expect(second.getByText("Your backup is ready for this device")).toBeVisible();
  await second.getByRole("button", { name: "Restore" }).click();
  const keyBox = second.getByLabel("Recovery key");
  await keyBox.fill("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");
  await second.getByRole("button", { name: "Unlock with the recovery key" }).click();
  await expect(
    second.getByText("That recovery key doesn't match. Check it and try again."),
  ).toBeVisible();
  await keyBox.fill(recoveryKey.toLowerCase());
  await second.getByRole("button", { name: "Unlock with the recovery key" }).click();
  await expect(second.getByText(/^Restored \d+ items?\. This device now syncs\./)).toBeVisible();
  await expect(second.getByRole("button", { name: "Back up now" })).toBeVisible();

  // The jar is there; a deposit on this device reaches the first one on its next open.
  await second.goto("/goals");
  await second.getByText(JAR).first().click();
  await second.getByLabel("Other amount").fill("250");
  await second.getByRole("button", { name: "Log" }).click();
  await expect(second.getByText("$350").first()).toBeVisible();
  await second.goto("/me/security");
  await second.getByRole("button", { name: "Back up now" }).click();
  await expect(second.getByText("Backed up just now.")).toBeVisible();
  await page.goto("/goals");
  await expect(page.getByText("$350").first()).toBeVisible({ timeout: 20_000 });

  // Turn it off: the server forgets it, the device keeps its data.
  await page.goto("/me/security");
  await page.getByRole("button", { name: "Turn off backup" }).click();
  await page
    .getByRole("dialog", { name: "Turn off backup?" })
    .getByRole("button", { name: "Turn off backup" })
    .click();
  await expect(page.getByText("Backup is off. Your data stays on this device.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on encrypted backup" })).toBeVisible();
  await page.goto("/goals");
  await expect(page.getByText(JAR).first()).toBeVisible();

  // Nothing readable ever left a device.
  expect(sent.some((b) => b.length > 1000)).toBe(true); // the backups went up
  for (const body of sent) expect(body).not.toContain(JAR);
});
