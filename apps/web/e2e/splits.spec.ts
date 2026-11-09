import { expect, type Page, test } from "@playwright/test";
import { newEmail, readyAccount, signUp } from "./helpers.ts";

/** Every request body and URL the page sent, to check nothing readable about a bill left. */
function sent(page: Page): string[] {
  const out: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    // Ciphertext and wrapped keys are base64url; any short run of letters can appear in them.
    if (!path.startsWith("/api/") || /\/(blobs|keys)\//.test(path)) return;
    out.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  return out;
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
  for (const line of [...orgSent, ...friendSent])
    for (const secret of ["Lake house", "7Q", "Internet", "Snacks"])
      expect(line.includes(secret), `${secret} in ${line.slice(0, 120)}`).toBe(false);
});
