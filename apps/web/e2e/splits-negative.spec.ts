import { expect, type Page, test } from "@playwright/test";
import { newEmail, readyAccount, signUp } from "./helpers.ts";

/**
 * Split bills when things go wrong (November 12, 2026): every finishing button says what's
 * missing instead of going grey; an invite opens only for the inbox it was sent to and only
 * once; a cancelled or declined invite stays closed; someone outside the group sees nothing;
 * only the organizer changes the group; a declined bill moves nobody; and with "Guests can add
 * bills" off, a guest can't add one even by calling the server directly.
 */

async function openGroup(page: Page, gid: string) {
  await page.goto(`/splits/${gid}`);
}

/** Calls the API from the page, as its own session, and returns the status and error code. */
async function call(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; code: string | null }> {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(p as string, {
        method: m as string,
        headers: { "content-type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await r.text();
      let code: string | null = null;
      try {
        const detail = (JSON.parse(text) as { detail?: unknown }).detail;
        code = typeof detail === "string" ? detail : null;
      } catch {
        code = null;
      }
      return { status: r.status, code };
    },
    [method, path, body] as const,
  );
}

/** Sends an invite from the open "Invite by email" sheet and returns its token. */
async function sendInvite(org: Page, gid: string, email: string): Promise<string> {
  const sheet = org.getByRole("dialog", { name: "Invite by email" });
  await sheet.getByLabel("Their email").fill(email);
  const invited = org.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/splits/${gid}/invites`),
  );
  await sheet.getByRole("button", { name: "Send invite" }).click();
  const res = await invited;
  expect(res.status()).toBe(201);
  const { token } = (await res.json()) as { token: string };
  await expect(sheet.getByText(`Invite sent to ${email}`)).toBeVisible();
  await sheet.getByRole("button", { name: "Done" }).click();
  return token;
}

async function openInviteSheet(org: Page) {
  await org.getByRole("button", { name: "Invite", exact: true }).click();
  return org.getByRole("dialog", { name: "Invite by email" });
}

test("split bills, negative: wrong input, wrong person, used links and organizer-only actions", async ({
  browser,
}) => {
  test.setTimeout(240_000);

  // The organizer starts a group; the invite sheet opens by itself.
  const org = await (await browser.newContext()).newPage();
  const orgEmail = await readyAccount(org, "neg-org");
  await org.goto("/splits");
  await org.getByRole("link", { name: "+ New group" }).click();
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("alert")).toBeVisible(); // no group name: said, not greyed out
  await org.getByLabel("Group name").fill("Dock 5K");
  await org.getByLabel("Your name, as the group sees it").fill("Jordan");
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("heading", { level: 1, name: "Dock 5K" })).toBeVisible();
  const gid = new URL(org.url()).pathname.split("/").at(-1) as string;

  // Invite: nothing typed, then their own email.
  const sheet = org.getByRole("dialog", { name: "Invite by email" });
  await sheet.getByRole("button", { name: "Send invite" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Enter their email.");
  await expect(sheet.getByLabel("Their email")).toBeFocused();
  await sheet.getByLabel("Their email").fill(orgEmail);
  await sheet.getByRole("button", { name: "Send invite" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("That's your own email.");

  // A real invite, then the same inbox again: one waiting invite per inbox.
  const friendEmail = newEmail("neg-friend");
  const token = await sendInvite(org, gid, friendEmail);
  const again = await openInviteSheet(org);
  await again.getByLabel("Their email").fill(friendEmail);
  // The sheet knows before sending: it says so and offers no Send (the reason is on screen).
  await expect(again).toContainText("Already invited");
  await expect(again).toContainText("You can remind them again tomorrow.");
  await expect(again.getByRole("button", { name: "Send invite" })).toHaveCount(0);
  await org.keyboard.press("Escape");
  // And the server refuses a second invite to the same inbox on its own.
  expect(
    await call(org, "POST", `/api/splits/${gid}/invites`, { email: friendEmail.toUpperCase() }),
  ).toEqual({ status: 409, code: "already_invited" });

  // Invites waiting: sent today, so Remind waits until tomorrow.
  const waiting = org.getByRole("region", { name: "Invites waiting" });
  await expect(waiting).toContainText(friendEmail);
  await expect(waiting).toContainText("Remind again tomorrow");
  await expect(waiting.getByRole("button", { name: "Remind tomorrow" })).toBeDisabled();

  // Add a bill: nothing, then $0, then no "what for". Each one is named, never a grey button.
  await org.getByRole("link", { name: "Add a bill" }).click();
  const add = org.getByRole("button", { name: "Add bill" });
  await add.click();
  await expect(org.getByRole("alert")).toHaveText("Enter how much.");
  await expect(org.getByLabel("1 · How much?")).toBeFocused();
  await org.getByLabel("1 · How much?").fill("0");
  await add.click();
  await expect(org.getByRole("alert")).toHaveText("Enter an amount above $0.");
  await org.getByLabel("1 · How much?").fill("40");
  await add.click();
  await expect(org.getByRole("alert")).toHaveText("Say what it's for.");
  await expect(org.getByLabel("What's it for?")).toBeFocused();
  await org.getByLabel("What's it for?").fill("Fuel 5K");
  await add.click();
  await expect(org.getByRole("heading", { level: 1, name: "Dock 5K" })).toBeVisible();

  // A stranger: the friend's link isn't theirs, a made-up link is dead, a bare link says so,
  // and the group itself is a 404 with nothing shown.
  const stranger = await (await browser.newContext()).newPage();
  await readyAccount(stranger, "neg-stranger");
  await stranger.goto(`/splits/join#t=${token}`);
  await expect(stranger.getByRole("alert")).toHaveText(
    "This invite is for a different email. Sign in with the address it was sent to.",
  );
  // A second link in the same window: only the part after # changes, and it's read.
  await stranger.goto("/splits/join#t=not-a-real-invite-token");
  await expect(stranger.getByRole("alert")).toHaveText(
    "This invite has expired or was already used. Ask for a new one.",
  );
  await stranger.goto("/splits/join");
  await expect(stranger.getByRole("alert")).toHaveText(
    "This link is missing its invite. Open it again from the email.",
  );
  await openGroup(stranger, gid);
  await expect(stranger.getByText("You're not in this group any more.")).toBeVisible();
  await expect(stranger.getByText("Dock 5K")).toHaveCount(0);
  expect((await call(stranger, "GET", `/api/splits/${gid}/state`)).status).toBe(404);
  expect((await call(stranger, "POST", `/api/splits/${gid}/bills`)).status).toBe(404);
  expect(
    (await call(stranger, "PATCH", `/api/splits/${gid}`, { guests_can_add: false })).status,
  ).toBe(404);

  // The friend joins through the link (their name first), and the link is then used up.
  const friend = await (await browser.newContext()).newPage();
  await signUp(friend, friendEmail);
  await friend
    .getByRole("radio", { name: /Private/ })
    .locator("xpath=ancestor::label")
    .click();
  await friend.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await friend.getByRole("button", { name: "Done for now" }).click();
  await friend.goto(`/splits/join#t=${token}`);
  await friend.getByRole("button", { name: "I know Jordan · Join" }).click();
  await expect(friend.getByRole("alert")).toBeVisible(); // no name yet: said first
  await friend.getByLabel("Your name, as the group sees it").fill("Sam");
  await friend.getByRole("button", { name: "I know Jordan · Join" }).click();
  await expect(friend).toHaveURL(new RegExp(`/splits/${gid}$`));
  expect(await call(friend, "POST", "/api/splits/invites/accept", { token })).toEqual({
    status: 404,
    code: "not_found",
  });
  await friend.goto(`/splits/join#t=${token}`);
  await expect(friend.getByRole("alert")).toHaveText(
    "This invite has expired or was already used. Ask for a new one.",
  );

  // Only the organizer changes the group: the friend's direct calls are refused.
  expect(await call(friend, "PATCH", `/api/splits/${gid}`, { guests_can_add: false })).toEqual({
    status: 403,
    code: "organizer_only",
  });
  const list = (await (await org.request.get("/api/splits")).json()) as {
    groups: { id: string; members: { member_id: string; is_organizer: boolean }[] }[];
  };
  const orgMember = list.groups.find((g) => g.id === gid)?.members.find((m) => m.is_organizer)
    ?.member_id as string;
  expect((await call(friend, "DELETE", `/api/splits/${gid}/members/${orgMember}`)).code).toBe(
    "organizer_only",
  );

  // The organizer's open app hands the friend the key; the friend's bill waits and is declined.
  await openGroup(org, gid);
  await expect(org.getByRole("list", { name: "People" }).getByRole("listitem")).toHaveCount(2);
  await expect(async () => {
    await openGroup(friend, gid);
    await expect(friend.getByRole("heading", { level: 1, name: "Dock 5K" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  // Fuel was added before they joined: it was split among the group then, so it's not theirs.
  await expect(friend.getByText(/Fuel 5K/)).toBeVisible();
  await expect(friend.getByRole("region", { name: "Your balance" })).toContainText("Clear");
  await friend.getByRole("link", { name: "Add a bill" }).click();
  await friend.getByLabel("1 · How much?").fill("50");
  await friend.getByLabel("What's it for?").fill("Bait 5K");
  await friend.getByRole("button", { name: /^Send to / }).click();
  await expect(friend.getByRole("heading", { name: /^Waiting for / })).toBeVisible();
  await openGroup(org, gid);
  const ok = org.getByRole("region", { name: "Waiting for your OK" });
  await expect(ok).toContainText("Bait 5K · $50.00");
  await ok.getByRole("button", { name: "Decline" }).click();
  await expect(org.getByText("Declined.")).toBeVisible();
  await expect(org.getByRole("region", { name: "Waiting for your OK" })).toHaveCount(0);
  await expect(org.getByRole("region", { name: "Your balance" })).toContainText("Clear"); // nothing moved
  await openGroup(friend, gid);
  await expect(friend.getByRole("region", { name: "Your balance" })).toContainText("Clear");
  await expect(friend.getByRole("heading", { name: /^Waiting for / })).toHaveCount(0);

  // Guests can add bills: off. The link goes, and the server refuses a direct call too.
  await openGroup(org, gid);
  const guestsCanAdd = org.getByRole("switch", { name: "Guests can add bills" });
  await guestsCanAdd.locator("xpath=ancestor::label").click(); // tap the row, as a person does
  await expect(guestsCanAdd).not.toBeChecked();
  await expect(org.getByText("Only you add bills now.")).toBeVisible();
  await openGroup(friend, gid);
  await expect(friend.getByRole("heading", { level: 1, name: "Dock 5K" })).toBeVisible();
  await expect(friend.getByRole("link", { name: "Add a bill" })).toHaveCount(0);
  expect(await call(friend, "POST", `/api/splits/${gid}/bills`)).toEqual({
    status: 403,
    code: "guests_cannot_add",
  });
});

test("split bills, negative: a cancelled invite is dead, and 'I don't know them' stops the next one", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const org = await (await browser.newContext()).newPage();
  await readyAccount(org, "neg2-org");
  await org.goto("/splits");
  await org.getByRole("link", { name: "+ New group" }).click();
  await org.getByLabel("Group name").fill("Pier 2T");
  await org.getByLabel("Your name, as the group sees it").fill("Jordan");
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("heading", { level: 1, name: "Pier 2T" })).toBeVisible();
  const gid = new URL(org.url()).pathname.split("/").at(-1) as string;

  // Two invites: one is cancelled, the other is declined.
  const goneEmail = newEmail("neg2-gone");
  const goneToken = await sendInvite(org, gid, goneEmail);
  const noEmail = newEmail("neg2-no");
  await openInviteSheet(org);
  const noToken = await sendInvite(org, gid, noEmail);
  const waiting = org.getByRole("region", { name: "Invites waiting" });
  await waiting.getByRole("button", { name: `Cancel ${goneEmail}` }).click();
  await expect(waiting.getByText("Invite cancelled.")).toBeVisible();
  await expect(waiting).not.toContainText(goneEmail);

  // The cancelled invite opens nothing for its own inbox.
  const goneAcct = await (await browser.newContext()).newPage();
  await signUp(goneAcct, goneEmail);
  await goneAcct.goto(`/splits/join#t=${goneToken}`);
  await expect(goneAcct.getByRole("alert")).toHaveText(
    "This invite has expired or was already used. Ask for a new one.",
  );

  // "I don't know Jordan": nobody is added, and Jordan can't invite that inbox again.
  const no = await (await browser.newContext()).newPage();
  await signUp(no, noEmail);
  await no.goto(`/splits/join#t=${noToken}`);
  await no.getByRole("button", { name: "I don't know Jordan" }).click();
  await expect(no.getByRole("status")).toContainText(
    "Thanks for telling us. Jordan can't invite this email again.",
  );
  expect(await call(no, "POST", "/api/splits/invites/accept", { token: noToken })).toEqual({
    status: 404,
    code: "not_found",
  });
  await openGroup(org, gid);
  await expect(org.getByRole("list", { name: "People" }).getByRole("listitem")).toHaveCount(1);
  const retry = await openInviteSheet(org);
  await retry.getByLabel("Their email").fill(noEmail);
  await retry.getByRole("button", { name: "Send invite" }).click();
  await expect(retry.getByRole("alert")).toHaveText(
    "They said they don't know you. You can't invite that email again.",
  );
});
