import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

const LOG = join(import.meta.dirname, ".output", "api.log");

/** A fresh address per test, so trials (once per email) and limits never collide. */
export function newEmail(tag: string): string {
  return `e2e-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

/** The latest sign-in code the API "emailed" to this address (console backend log). */
export async function codeFor(email: string, after = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const log = readFileSync(LOG, "utf8");
    const re = new RegExp(
      `--- email to ${email.replace(/[.+]/g, "\\$&")}\\nSubject: Your Qash code: (\\d{6})`,
      "g",
    );
    const codes = [...log.matchAll(re)].map((m) => m[1] as string);
    if (codes.length > after) return codes[codes.length - 1] as string;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code emailed to ${email}`);
}

export function codesSent(email: string): number {
  const log = readFileSync(LOG, "utf8");
  return log.split(`--- email to ${email}\nSubject: Your Qash code:`).length - 1;
}

/**
 * Chrome's virtual authenticator: a platform passkey with user verification, answering every
 * prompt at once, like Touch ID that always says yes. One per page.
 */
export async function addPasskeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/**
 * Each test gets its own made-up client address, as the API's own tests do, so the per-IP
 * limits on codes and sign-ins apply per test rather than to the whole run.
 */
export async function ownAddress(page: Page): Promise<void> {
  const n = () => 1 + Math.floor(Math.random() * 250);
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": `10.${n()}.${n()}.${n()}` });
}

/** Email code, then the passkey: a new account, signed in and unlocked. */
export async function signUp(page: Page, email: string): Promise<void> {
  await ownAddress(page);
  await addPasskeyDevice(page);
  await page.goto("/signin");
  await page.getByLabel("Email address").fill(email);
  const before = codesSent(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const code = await codeFor(email, before);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create passkey" }).click();
  await expect(page.getByRole("heading", { name: "You're protected" })).toBeVisible();
  await page
    .getByRole("button", { name: /Continue|Go|Start|Done/ })
    .first()
    .click();
}

/** Sign up, take the Private trial and skip setup: a ready account on Home. */
export async function readyAccount(page: Page, tag: string): Promise<string> {
  const email = newEmail(tag);
  await signUp(page, email);
  await page.getByRole("radio", { name: /Private/ }).check();
  await page.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect(page.getByText(/Private trial · \d days? left/)).toBeVisible();
  return email;
}

export const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");
