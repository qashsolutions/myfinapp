import { expect, type Page, test } from "@playwright/test";
import { newEmail, readyAccount, setName, signUp } from "./helpers.ts";

/**
 * Split bills, round two (chunk S.6, November 10, 2026): the organizer sets the usual split by
 * shares and a friend's bill follows it; the bill's history shows the approval and the change;
 * paying a friend back is added to the payer's spending once; and when the organizer's account
 * is deleted, the friend runs the group with every correction kept. S.7: the payment's note in
 * the group's History.
 */

async function openGroup(page: Page, gid: string) {
  await page.goto(`/splits/${gid}`);
}

test("split bills round two: usual split by shares, a bill's history, paying back as spending, Run this group", async ({
  browser,
}) => {
  const org = await (await browser.newContext()).newPage();
  await readyAccount(org, "s6-org");
  await setName(org, "Jordan");
  await org.goto("/splits");
  await org.getByRole("link", { name: "+ New group" }).click();
  await org.getByLabel("Group name").fill("Cabin 9X");
  await org.getByRole("button", { name: "Create and invite" }).click();
  await expect(org.getByRole("heading", { level: 1, name: "Cabin 9X" })).toBeVisible();
  const gid = new URL(org.url()).pathname.split("/").at(-1) as string;

  // Riley, with a Private trial of their own, is invited by email and joins.
  const rileyEmail = newEmail("s6-riley");
  const invite = org.getByRole("dialog", { name: "Invite by email" });
  await invite.getByLabel("Their email").fill(rileyEmail);
  const invited = org.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/splits/${gid}/invites`),
  );
  await invite.getByRole("button", { name: "Send invite" }).click();
  const { token } = (await (await invited).json()) as { token: string };
  await invite.getByRole("button", { name: "Done" }).click();
  const riley = await (await browser.newContext()).newPage();
  await signUp(riley, rileyEmail);
  const trial = riley.getByRole("radio", { name: /Private/ });
  await trial.locator("xpath=ancestor::label").click();
  await riley.getByRole("button", { name: "Start my 3-day free trial" }).click();
  await riley.getByRole("button", { name: "Done for now" }).click();
  await setName(riley, "Riley");
  const accepted = await riley.evaluate(async (t) => {
    const r = await fetch("/api/splits/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    return r.status;
  }, token);
  expect(accepted).toBe(200);
  await openGroup(riley, gid);
  await openGroup(org, gid); // hands Riley the group's key

  // The usual split: Jordan 2 shares, Riley 1.
  await org.getByRole("button", { name: "Name, usual split and more" }).click();
  const settings = org.getByRole("dialog", { name: "Group settings" });
  await settings.getByRole("radio", { name: "Shares" }).locator("xpath=ancestor::label").click();
  await settings.getByLabel("You, shares").fill("2");
  await settings.getByLabel("Riley, shares").fill("1");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings).toBeHidden();

  // Riley's bill follows it, locked, and waits for Jordan.
  await expect(async () => {
    await openGroup(riley, gid);
    await expect(riley.getByRole("heading", { level: 1, name: "Cabin 9X" })).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await riley.getByRole("link", { name: "Add a bill" }).click();
  await expect(riley.getByText(/^2 · Split by shares: Jordan 2 · You 1\./)).toBeVisible();
  await riley.getByLabel("1 · How much?").fill("30");
  await riley.getByLabel("What's it for?").fill("Firewood 9X");
  await riley.getByRole("button", { name: /^Send to / }).click();

  // Jordan approves it, then corrects the amount to $45.
  await openGroup(org, gid);
  await org
    .getByRole("region", { name: "Waiting for your OK" })
    .getByRole("button", { name: "Approve" })
    .click();
  await expect(org.getByText("You pay Riley $20.00")).toBeVisible();
  await org.getByText(/Firewood 9X/).click();
  await org.getByRole("button", { name: "Edit" }).click();
  await org.getByLabel("1 · How much?").fill("45");
  await org.getByRole("button", { name: "Save changes" }).click();
  await expect(org.getByText("You pay Riley $30.00")).toBeVisible();

  // Riley sees the bill's history.
  await openGroup(riley, gid);
  await riley.getByText(/Firewood 9X/).click();
  const history = riley.getByRole("region", { name: "History" });
  await expect(history).toContainText("Added by You");
  await expect(history).toContainText("Approved by Jordan");
  await expect(history).toContainText("Changed by Jordan: amount $30.00 → $45.00");
  await riley.keyboard.press("Escape");

  // Jordan pays Riley back: with no statements here, it's added to Jordan's spending once.
  await openGroup(org, gid);
  await org.getByRole("button", { name: "Mark paid" }).click();
  const paid = org.getByRole("dialog", { name: "Mark paid" });
  await expect(paid.getByRole("switch", { name: "Add it to my spending" })).toBeChecked();
  await paid.getByLabel("Note (optional)").fill("Venmo on Sunday");
  await paid.getByRole("button", { name: "Mark paid" }).click();
  await expect(paid).toBeHidden();
  await expect(org.getByRole("region", { name: "Your balance" })).toContainText("Clear");

  // The group's History (S.7): the payment with its note, the change, who added what.
  await org.getByRole("button", { name: "History" }).click();
  const log = org.getByRole("dialog", { name: "History" });
  await expect(log.getByText(/You paid Riley \$30\.00 · Venmo on Sunday/)).toBeVisible();
  await expect(log.getByText(/You changed Firewood 9X: amount \$30\.00 → \$45\.00/)).toBeVisible();
  await expect(log.getByText(/Added Firewood 9X, \$30\.00, by Riley/)).toBeVisible();
  await org.keyboard.press("Escape");
  await org.goto("/money?view=transactions");
  await expect(org.getByText("Paid Riley")).toHaveCount(1);

  // Jordan deletes their account; Riley runs the group, and the correction stands.
  await org.goto("/me");
  await org.getByRole("button", { name: "Delete account" }).click();
  await org.getByText("I understand this permanently deletes my account and its data.").click();
  await org.getByRole("button", { name: "Delete forever" }).click();
  await expect(
    org.getByRole("heading", { level: 1, name: "Your account is deleted" }),
  ).toBeVisible();
  await openGroup(riley, gid);
  await expect(riley.getByText(/nobody runs this group now/)).toBeVisible();
  await expect(riley.getByRole("heading", { level: 1, name: "Cabin 9X" })).toBeVisible();
  await riley.getByRole("button", { name: "Run this group" }).click();
  await expect(riley.getByText("You run this group now.")).toBeVisible();
  await expect(riley.getByRole("heading", { level: 1, name: "Cabin 9X" })).toBeVisible();
  await expect(riley.getByText(/Firewood 9X · \$45\.00|\$45\.00/).first()).toBeVisible();
  await expect(riley.getByRole("link", { name: "Add a bill" })).toBeVisible();
});
