import { expect, type Page, test } from "@playwright/test";
import { newEmail, readyAccount, signUp } from "./helpers.ts";

/** Every request body and URL the page sent, to check nothing readable about a bill left. */
function sent(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    // Ciphertext and wrapped keys are base64url; any short run of letters can appear in them.
    if (!path.startsWith("/api/") || /\/(blobs|keys)\//.test(path)) return;
    out.push(`${safeDecode(r.url())} ${r.postData() ?? ""}`);
  });
  return out;
}

/** A URL read as text, so a name sent as `Lake%20house` is still caught. */
function safeDecode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Fails when a readable name went out. Markers are whole names, never a short code like "7Q":
 * sign-up sends the passkey's credential as a kilobyte or two of base64url, where any two
 * characters turn up by chance in about a third of runs (the flaky failures of November 9, 2026).
 */
function expectNothingReadable(lines: string[], names: string[]) {
  for (const line of lines)
    for (const name of names)
      expect(line.includes(name), `${name} in ${line.slice(0, 120)}`).toBe(false);
}

/** The split group's screen, read fresh from the server. */
async function openGroup(page: Page, gid: string) {
  await page.goto(`/splits/${gid}`);
}

test("split bills: the organizer starts a group, a friend joins, bills wait for the OK, Mark paid settles it", async ({
  browser,
}) => {
  // The organizer, on a Private trial
  const org = await (await browser.newContext()).newPage();
  const orgSent = sent(org);
  await readyAccount(org, "split-org");
  await org.goto("/goals?tab=splits");
  await org.getByRole("link", { name: "+ New group" }).click();
  await org.getByLabel("Group name").fill("Lake house 7Q");
  await org.getByLabel("Your name, as the group sees it").fill("Jordan");
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("heading", { level: 1, name: "Lake house 7Q" })).toBeVisible();
  const gid = new URL(org.url()).pathname.split("/").at(-1) as string;

  // Invite a friend by email; the token comes back for the in-person QR code
  const friendEmail = newEmail("split-friend");
  const sheet = org.getByRole("dialog", { name: "Invite by email" });
  await sheet.getByLabel("Their email").fill(friendEmail);
  const invited = org.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/splits/${gid}/invites`),
  );
  await sheet.getByRole("button", { name: "Send invite" }).click();
  const { token } = (await (await invited).json()) as { token: string };
  await expect(sheet.getByText(`Invite sent to ${friendEmail}`)).toBeVisible();
  await sheet.getByRole("button", { name: "In person? Show a QR code" }).click();
  await expect(sheet.getByRole("img", { name: "QR code to join this group" })).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();

  // The friend signs up with that inbox (a Private trial of their own) and says yes
  const friend = await (await browser.newContext()).newPage();
  const friendSent = sent(friend);
  await signUp(friend, friendEmail);
  await friend.getByRole("radio", { name: /Private/ }).check();
  await friend.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await friend.getByRole("button", { name: "Done for now" }).click();
  const accepted = await friend.evaluate(async (t) => {
    const r = await fetch("/api/splits/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    return r.status;
  }, token);
  expect(accepted).toBe(200);

  // Their device asks for the key; the organizer's device hands it over when it opens the group
  await openGroup(friend, gid);
  await expect(friend.getByText(/needs the group's key/)).toBeVisible();
  await openGroup(org, gid);
  await expect(org.getByRole("list", { name: "People" }).getByRole("listitem")).toHaveCount(2);

  // The organizer adds Internet, $90 split equally
  await org.getByRole("link", { name: "Add a bill" }).click();
  await org.getByLabel("1 · How much?").fill("90");
  await org.getByLabel("What's it for?").fill("Internet 7Q");
  await expect(org.getByText("Only $45.00 counts as yours.")).toBeVisible();
  await org.getByRole("button", { name: "Add bill" }).click();
  await expect(org.getByText(/pays you \$45\.00/)).toBeVisible();

  // The friend now holds the key, sees the bill and adds one of their own: it waits
  await expect(async () => {
    await openGroup(friend, gid);
    await expect(friend.getByRole("heading", { level: 1, name: "Lake house 7Q" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(friend.getByText(/You pay .* \$45\.00/)).toBeVisible();
  await friend.getByRole("link", { name: "Add a bill" }).click();
  await friend.getByLabel("1 · How much?").fill("30");
  await friend.getByLabel("What's it for?").fill("Snacks 7Q");
  await friend.getByRole("button", { name: /^Send to / }).click();
  await expect(friend.getByRole("heading", { name: /^Waiting for / })).toBeVisible();
  await expect(friend.getByText(/You pay .* \$45\.00/)).toBeVisible(); // waiting moves nobody

  // The organizer approves it: $45 − $15 = $30 to settle
  await openGroup(org, gid);
  const waiting = org.getByRole("region", { name: "Waiting for your OK" });
  await expect(waiting).toContainText("Snacks 7Q · $30.00");
  await waiting.getByRole("button", { name: "Approve" }).click();
  await expect(org.getByText(/pays you \$30\.00/)).toBeVisible();

  // Paid outside Qash; the organizer, who was paid, marks it and everyone is clear
  await org.getByRole("button", { name: "Mark paid" }).click();
  await org
    .getByRole("dialog", { name: "Mark paid" })
    .getByRole("button", { name: "Mark paid" })
    .click();
  await expect(org.getByRole("region", { name: "Your balance" })).toContainText("Clear");
  await openGroup(friend, gid);
  await expect(friend.getByRole("region", { name: "Your balance" })).toContainText("Clear");

  // Invariant 78: no group name, bill or what it was for went out readable from either device
  expectNothingReadable(
    [...orgSent, ...friendSent],
    ["Lake house", "Internet", "Snacks", "Lake house 7Q", "Internet 7Q", "Snacks 7Q"],
  );
});

test("@phone split bills: a free guest joins from the email link, disputes, pays through Check first and leaves", async ({
  browser,
}) => {
  const org = await (await browser.newContext()).newPage();
  await readyAccount(org, "split-host");
  // The organizer saves how friends pay them (a passkey check first)
  await org.goto("/goals?tab=splits");
  await org.getByRole("link", { name: "+ New group" }).click();
  await org.getByLabel("Group name").fill("Cabin 3W");
  await org.getByLabel("Your name, as the group sees it").fill("Jordan");
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("heading", { level: 1, name: "Cabin 3W" })).toBeVisible();
  const gid = new URL(org.url()).pathname.split("/").at(-1) as string;
  const guestEmail = newEmail("split-guest");
  const sheet = org.getByRole("dialog", { name: "Invite by email" });
  await sheet.getByLabel("Their email").fill(guestEmail);
  const invited = org.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/splits/${gid}/invites`),
  );
  await sheet.getByRole("button", { name: "Send invite" }).click();
  const { token } = (await (await invited).json()) as { token: string };
  await sheet.getByRole("button", { name: "Done" }).click();

  // The guest signs up with that inbox and never picks a trial: the invite still opens
  const guest = await (await browser.newContext()).newPage();
  const guestSent = sent(guest);
  await signUp(guest, guestEmail);
  await expect(guest).toHaveURL(/\/start/);
  await guest.goto(`/splits/join#t=${token}`);
  await expect(guest.getByRole("region", { name: "Who's inviting you" })).toContainText(
    "invited you to split bills",
  );
  await guest.getByLabel("Your name, as the group sees it").fill("Sam");
  await guest.getByRole("button", { name: "I know Jordan · Join" }).click();
  // The two-tab guest app, waiting for the key from the organizer's device
  const nav = guest.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveText(["Splits", "Me"]);
  await expect(guest.getByText(/needs the group's key/)).toBeVisible();
  await org.goto(`/splits/${gid}`);
  await expect(org.getByRole("list", { name: "People" }).getByRole("listitem")).toHaveCount(2);

  // The organizer adds a bill, and saves how friends pay them
  await org.getByRole("link", { name: "Add a bill" }).click();
  await org.getByLabel("1 · How much?").fill("120");
  await org.getByLabel("What's it for?").fill("Firewood 3W");
  await org.getByRole("button", { name: "Add bill" }).click();
  await expect(org.getByText(/pays you \$60\.00/)).toBeVisible();
  await org.goto("/me/split-pay");
  await org.getByLabel("Venmo").fill("@cabin-host");
  await org.getByRole("button", { name: "Save" }).click();
  await expect(org.getByText("Saved in 1 group.")).toBeVisible();

  // The guest sees it, disputes it, withdraws, then adds a bill of their own (it waits)
  await expect(async () => {
    await guest.goto(`/splits/${gid}`);
    await expect(guest.getByRole("heading", { level: 1, name: "Cabin 3W" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(guest.getByText(/You pay .* \$60\.00/)).toBeVisible();
  await guest.getByRole("button", { name: /Firewood 3W/ }).click();
  await guest.getByRole("button", { name: "This isn't right · Dispute" }).click();
  await expect(guest.getByText(/1 disputed bill is on hold/)).toBeVisible();
  await guest.getByRole("button", { name: /Firewood 3W/ }).click();
  await guest.getByRole("button", { name: "Withdraw my dispute" }).click();
  await expect(guest.getByText(/You pay .* \$60\.00/)).toBeVisible();
  await guest.getByRole("link", { name: "Add a bill" }).click();
  await guest.getByLabel("1 · How much?").fill("20");
  await guest.getByLabel("What's it for?").fill("Matches 3W");
  await guest.getByRole("button", { name: /^Send to / }).click();
  await expect(guest.getByRole("heading", { name: /^Waiting for / })).toBeVisible();

  // Check first, then the organizer's Venmo with the amount; "I've paid" waits for them
  const pay = guest.locator(".split-pay").filter({ hasText: /You pay .* \$60\.00/ });
  await pay.getByRole("button", { name: "Pay" }).click();
  const check = guest.getByRole("dialog", { name: "Check first" });
  await expect(check).toContainText("Money you send can't be pulled back.");
  await expect(check).toContainText("Changed recently");
  await check.getByRole("checkbox", { name: /in real life/ }).check();
  await check.getByRole("checkbox", { name: "I checked the bills and I owe this amount." }).check();
  await check.getByRole("button", { name: "Continue" }).click();
  await expect(check.getByRole("link", { name: "Open Venmo · $60.00" })).toHaveAttribute(
    "href",
    "https://venmo.com/cabin-host?txn=pay&amount=60.00",
  );
  await check.getByRole("button", { name: "I've paid · Mark paid" }).click();
  await expect(guest.getByText(/Waiting for .* to confirm your \$60\.00/)).toBeVisible();
  await guest.goto("/me/split-payments");
  await expect(guest.getByRole("list", { name: "Payments I confirmed" })).toContainText("$60.00");

  // The organizer confirms it and approves the guest's bill: $10 the other way
  await org.goto(`/splits/${gid}`);
  await org
    .getByRole("region", { name: "Did they pay you?" })
    .getByRole("button", { name: "Confirm" })
    .click();
  await org
    .getByRole("region", { name: "Waiting for your OK" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(org.getByText(/You pay .* \$10\.00/)).toBeVisible();

  // The guest reports and leaves
  await guest.goto(`/splits/${gid}`);
  await guest.getByRole("button", { name: "Leave or report" }).click();
  await guest.getByRole("button", { name: "Something's wrong? Report and leave" }).click();
  const report = guest.getByRole("dialog", { name: "Report and leave" });
  await report.getByRole("radio", { name: "Something else" }).check();
  await report.getByRole("button", { name: "Report and leave" }).click();
  await expect(guest).toHaveURL(/\/(splits|start)$/);

  expectNothingReadable(guestSent, [
    "Cabin",
    "Firewood",
    "Matches",
    "cabin-host",
    "Cabin 3W",
    "Firewood 3W",
    "Matches 3W",
  ]);
});
