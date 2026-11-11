import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CDPSession, expect, type Page } from "@playwright/test";

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

const devices = new WeakMap<Page, { cdp: CDPSession; id: string }>();
const keys = new WeakMap<Page, { cdp: CDPSession; id: string }>();

/**
 * Chrome's virtual authenticator: a platform passkey with user verification, answering every
 * prompt at once, like Touch ID that always says yes. One per page. It also answers the PRF
 * extension, as Touch ID and Android's passkeys do, so an encrypted backup can be opened with it.
 */
export async function addPasskeyDevice(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  devices.set(page, { cdp, id: authenticatorId });
}

/** A security key plugged in beside this page's device (USB, with its own PIN check). */
export async function addSecurityKey(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  keys.set(page, { cdp, id: authenticatorId });
  return cdp;
}

/** How many passkeys the security key on this page holds. */
export async function passkeysOnKey(page: Page): Promise<number> {
  const k = keys.get(page);
  if (!k) return 0;
  return (await k.cdp.send("WebAuthn.getCredentials", { authenticatorId: k.id })).credentials
    .length;
}

/**
 * The passkeys on one page's device copied to another's: a passkey synced by the platform
 * (iCloud Keychain, Google Password Manager) to a second device of the same person.
 */
export async function syncPasskeys(from: Page, to: Page): Promise<void> {
  const a = devices.get(from);
  const b = devices.get(to);
  if (!a || !b) throw new Error("both pages need addPasskeyDevice first");
  const { credentials } = await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.id });
  for (const credential of credentials)
    await b.cdp.send("WebAuthn.addCredential", { authenticatorId: b.id, credential });
}

/**
 * This device's app data erased (the browser's site data cleared, IndexedDB and local storage)
 * while its passkey and the session cookie stay, then the app opened again.
 */
export async function wipeDeviceData(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Storage.clearDataForOrigin", {
    origin: new URL(page.url()).origin,
    storageTypes: "indexeddb,local_storage",
  });
  await page.goto("/");
}

/** How many passkeys this page's device holds. */
export async function passkeysOn(page: Page): Promise<number> {
  const d = devices.get(page);
  if (!d) return 0;
  return (await d.cdp.send("WebAuthn.getCredentials", { authenticatorId: d.id })).credentials
    .length;
}

/**
 * Signing in on a device that already holds the account's passkey (synced to it): the sign-in
 * screen offers it in the email field's autofill (conditional mediation), and the virtual
 * authenticator takes that offer at once, as a person tapping their passkey there would.
 */
export async function signInHere(page: Page): Promise<void> {
  await ownAddress(page);
  await page.goto("/signin");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
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

/** Sign up, take a trial (Private unless named) and skip setup: a ready account on Home. */
export async function readyAccount(
  page: Page,
  tag: string,
  plan: "Private" | "Connected" = "Private",
): Promise<string> {
  const email = newEmail(tag);
  await signUp(page, email);
  // The radio is visually hidden inside its card: tap the card, as a person does.
  const radio = page.getByRole("radio", { name: new RegExp(plan) });
  await radio.locator("xpath=ancestor::label").click();
  await expect(radio).toBeChecked();
  await page.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await page.getByRole("button", { name: "Done for now" }).click();
  await expect(page.getByText(new RegExp(`${plan} trial · \\d days? left`))).toBeVisible();
  return email;
}

/**
 * Opens Me as a person would (November 11, 2026: Me left the tabs): the avatar at the top right
 * on a phone, or the rail's "signed in" footer → Your account on a computer.
 */
export async function openMe(page: Page): Promise<void> {
  const rail = page.locator(".rail");
  if (await rail.isVisible()) {
    await rail.getByRole("button", { expanded: false }).click();
    await rail.getByRole("link", { name: "Your account" }).click();
  } else {
    await page.getByRole("link", { name: "Me", exact: true }).click();
  }
  await expect(page.getByRole("heading", { level: 1, name: "Me" })).toBeVisible();
}

/** Me → Account → Your name: what group and household members see. */
export async function setName(page: Page, name: string): Promise<void> {
  await page.goto("/me/account");
  await page.getByRole("button", { name: /Your name/ }).click();
  const sheet = page.getByRole("dialog", { name: "Your name" });
  await sheet.getByLabel("Name").fill(name);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();
}

/**
 * A household invite opened signed out on a fresh device: sign up from it (email code, then a
 * passkey) and join the inviter's household. Returns the new account's email.
 */
export async function joinFromInvite(page: Page, link: string, inviter: string): Promise<string> {
  await ownAddress(page);
  await addPasskeyDevice(page);
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByRole("link", { name: "Get started" }).click();
  const email = newEmail("partner");
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
  await expect(page.getByText(`${inviter} invited you to share a household.`)).toBeVisible();
  await page.getByRole("button", { name: `Join ${inviter}'s household` }).click();
  await expect(page.getByText("Started the household")).toBeVisible();
  return email;
}

/** On a Connected account: Me → Household → Make an invite link, and the link it shows. */
export async function inviteLink(page: Page): Promise<string> {
  await page.goto("/me/household");
  await page.getByRole("button", { name: "Make an invite link" }).click();
  return (await page.locator(".household-link").innerText()).replace("Invite link:", "").trim();
}

/**
 * Dates from the day the suite runs, never a fixed calendar day (the suite must pass in any
 * month and year). The browser runs on the same machine, so its local date is this one.
 */
export function isoInDays(days: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** How the app names a day (lib/format.ts formatDay): "Nov 3", or "Jan 2, 2027" in another year. */
export function dayLabel(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return y === now.getFullYear()
    ? `${SHORT_MONTHS[m - 1]} ${d}`
    : `${SHORT_MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * A checking statement whose rows are all dated today, so "this month" holds them whatever
 * day the suite runs (tests/fixtures/statement_oct.csv has the same rows for the unit tests,
 * which fix the clock). Year-first dates, so the column can't be read day-first.
 */
export function statementThisMonth(name = "statement.csv") {
  const today = isoInDays(0);
  const csv = [
    "Posting Date,Description,Amount,Balance",
    `${today},CORNER MKT #214,-42.17,2100.00`,
    `${today},METRO TRANSIT,-2.75,2142.17`,
    `${today},PAYMENT TO CARD 4111111111111173,"-1,200.00",2144.92`,
    `${today},ACME PAYROLL,"2,400.00",3344.92`,
    "",
  ].join("\n");
  return { name, mimeType: "text/csv", buffer: Buffer.from(csv) };
}
