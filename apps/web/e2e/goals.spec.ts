import { expect, type Page, test } from "@playwright/test";
import { dayLabel, isoInDays, readyAccount } from "./helpers.ts";

/**
 * Goals end to end (November 13, 2026): jars and goals built through the sentence builder, with
 * the person's own name, amount and date; wrong values said in the sheet, which stays open;
 * deposits, check-ins, a balance update, pause, Move money, milestones, reaching the target and
 * removing; the plan's cap on jars and goals; and challenges between two people, where only
 * percentages ever reach the server and only the owner changes the group.
 */

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

/** A GET from the page as its own session, parsed. */
async function getJson<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (p) => (await fetch(p)).json(), path) as Promise<T>;
}

/** Every body this page sends to the groups API (anything but a GET). */
function groupBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/groups"))
      bodies.push(r.postData() ?? "");
  });
  return bodies;
}

/** Phone: the Challenges tab; from 900px Goals shows jars and challenges side by side. */
async function showChallenges(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Goals" })).toBeVisible();
  const tab = page.getByRole("radio", { name: "Challenges" });
  if (await tab.isVisible()) await tab.locator("xpath=ancestor::label").click();
}

/** A goal kind chip in the builder (a visually hidden radio inside its label). */
async function pickKind(page: Page, label: string): Promise<void> {
  const radio = page.getByRole("radio", { name: label, exact: true });
  await radio.locator("xpath=ancestor::label").click();
  await expect(radio).toBeChecked();
}

/** The default jar from the builder ("Save $2,000 for Travel"), straight to its screen. */
async function quickJar(page: Page, name?: string): Promise<string> {
  await page.goto("/goals/new");
  await expect(page.getByRole("heading", { level: 1, name: "New goal" })).toBeVisible();
  if (name) {
    await page.getByRole("button", { name: "Change what it's for" }).click();
    const sheet = page.getByRole("dialog", { name: "What's it for?" });
    await sheet.getByLabel("Or name your own").fill(name);
    await sheet.getByRole("button", { name: "Use this" }).click();
    await expect(sheet).toBeHidden();
  }
  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page).toHaveURL(/\/goals\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

test("@phone a jar of my own: wrong values said in the sheet, deposits, pause, move money, milestones, reached, removed", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await readyAccount(page, "goals-jar");

  // A second jar first, so Move money has somewhere to go.
  await quickJar(page);
  await expect(page.getByRole("heading", { level: 1, name: "Travel" })).toBeVisible();

  await page.goto("/goals/new");
  // What it's for: a preset chip, then a name of my own. Too long is said and the sheet stays.
  await page.getByRole("button", { name: "Change what it's for" }).click();
  const what = page.getByRole("dialog", { name: "What's it for?" });
  await what.getByRole("radio", { name: "New car" }).check();
  await expect(page.getByRole("button", { name: "Change what it's for" })).toHaveText("New car");
  await what.getByLabel("Or name your own").fill("Grandma's 80th");
  await what.getByRole("button", { name: "Use this" }).click();
  await expect(what.getByRole("alert")).toHaveText("Give it a name, up to 10 characters.");
  await expect(what).toBeVisible();
  // Spaces only is no name at all: the sheet closes on the chosen chip, nothing changes.
  await what.getByLabel("Or name your own").fill("   ");
  await what.getByRole("button", { name: "Use this" }).click();
  await expect(what).toBeHidden();
  await expect(page.getByRole("button", { name: "Change what it's for" })).toHaveText("New car");
  await page.getByRole("button", { name: "Change what it's for" }).click();
  await what.getByLabel("Or name your own").fill("Bike fund");
  await what.getByRole("button", { name: "Use this" }).click();
  await expect(what).toBeHidden();
  await expect(page.getByRole("button", { name: "Change what it's for" })).toHaveText("Bike fund");

  // How much: garbage and $0 are refused in the sheet; a chip, then my own amount.
  await page.getByRole("button", { name: "Change amount" }).click();
  const amount = page.getByRole("dialog", { name: "How much?" });
  await amount.getByLabel("Or any amount").fill("lots");
  await amount.getByRole("button", { name: "Use this" }).click();
  await expect(amount.getByRole("alert")).toHaveText("Enter an amount like 1,500.");
  await amount.getByLabel("Or any amount").fill("0");
  await amount.getByRole("button", { name: "Use this" }).click();
  await expect(amount.getByRole("alert")).toHaveText("Enter an amount like 1,500.");
  await expect(amount).toBeVisible();
  await amount.getByRole("radio", { name: "$1,000.00" }).check();
  await expect(page.getByRole("button", { name: "Change amount" })).toHaveText("$1,000.00");
  await amount.getByLabel("Or any amount").fill("300");
  await amount.getByRole("button", { name: "Use this" }).click();
  await expect(amount).toBeHidden();
  await expect(page.getByRole("button", { name: "Change amount" })).toHaveText("$300.00");

  // By when: a day already gone is refused; a date of my own two months out is taken.
  await page.getByRole("button", { name: "Change deadline" }).click();
  const when = page.getByRole("dialog", { name: "By when?" });
  await when.getByLabel("Or pick a date").fill(isoInDays(-2));
  await when.getByRole("button", { name: "Use this" }).click();
  await expect(when.getByRole("alert")).toHaveText("Pick a date after today.");
  await expect(when).toBeVisible();
  const due = isoInDays(60);
  await when.getByLabel("Or pick a date").fill(due);
  await when.getByRole("button", { name: "Use this" }).click();
  await expect(when).toBeHidden();
  await expect(page.getByRole("button", { name: "Change deadline" })).toHaveText(dayLabel(due));
  await expect(page.getByRole("region", { name: "Pace" })).toContainText(
    /\$[\d,.]+ a week · \d+ weeks to \$300\.00/,
  );

  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bike fund" })).toBeVisible();
  const progress = page.getByRole("region", { name: "Progress" });
  await expect(progress.getByRole("img", { name: "0 percent" })).toBeVisible();
  await expect(progress).toContainText(`Save $300.00 for Bike fund by ${dayLabel(due)}`);
  // Milestones are on by default at 25%, 50% and 75% of the target.
  const milestones = page.getByRole("region", { name: "Milestones" });
  await expect(milestones).toContainText("25% · $75.00");
  await expect(milestones).toContainText("75% · $225.00");
  // Nothing saved yet: no money to move.
  await expect(page.getByRole("button", { name: "Move money" })).toBeDisabled();

  // A quick chip, then Other amount: garbage is said, a real amount logs.
  await page.getByRole("button", { name: "+$100.00" }).click();
  await expect(progress.getByRole("img", { name: "33 percent" })).toBeVisible();
  const other = page.getByLabel("Other amount");
  await other.fill("a lot");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter an amount like 76.00.");
  await other.fill("50");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(progress.getByRole("img", { name: "50 percent" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(milestones).toContainText("✓ 25% · $75.00");
  await expect(milestones).toContainText("✓ 50% · $150.00");
  await expect(page.getByRole("region", { name: "Recent" })).toContainText("+$50.00");

  // Pause and resume: the word follows.
  await page.getByRole("button", { name: "Pause jar" }).click();
  await expect(progress).toContainText("Paused");
  await page.getByRole("button", { name: "Resume jar" }).click();
  await expect(progress).toContainText("Saving");

  // Move money: more than the jar holds is said; $50 to Travel moves.
  await page.getByRole("button", { name: "Move money" }).click();
  const move = page.getByRole("dialog", { name: "Move money to another jar" });
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(move.getByRole("alert")).toHaveText("Enter an amount like 50 and pick a jar.");
  await move.getByLabel("To").selectOption({ label: "Travel" });
  await move.getByLabel("Amount").fill("500");
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(move.getByRole("alert")).toHaveText("This jar holds $150.00.");
  await move.getByLabel("Amount").fill("50");
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect(move).toBeHidden();
  await expect(page.getByText("Moved $50.00 to Travel.")).toBeVisible();
  await expect(progress.getByRole("img", { name: "33 percent" })).toBeVisible();

  // Reaching the target: 100% and the word Reached.
  await other.fill("200");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(progress.getByRole("img", { name: "100 percent" })).toBeVisible();
  await expect(progress).toContainText("Reached");
  await expect(page.getByRole("button", { name: "Move to my templates" })).toBeVisible();

  // On the list it folds under Reached, still counted; Travel holds the $50 moved.
  await page.goto("/goals");
  await expect(page.getByText("Reached · 1")).toBeVisible();
  await expect(page.getByText("Using 2 of 4 on your plan")).toBeVisible();
  await expect(page.getByRole("link", { name: "Travel" })).toContainText("$50.00 of $2,000.00");

  // Remove: one tap asks, the second archives it and frees its place.
  await page.getByText("Reached · 1").click();
  await page.getByRole("link", { name: /Bike fund/ }).click();
  await page.getByRole("button", { name: "Remove goal" }).click();
  await page.getByRole("button", { name: "Really remove this goal" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Goals" })).toBeVisible();
  await expect(page.getByText("Reached · 1")).toHaveCount(0);
  await expect(page.getByText("Using 1 of 4 on your plan")).toBeVisible();
});

test("a habit checks in once a day, a payoff takes a balance, spend-less asks the usual spend, and the fifth goal meets the plan's cap", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await readyAccount(page, "goals-cap");

  // Habit: a number of days outside 1–365 is said in the sheet; 10 days is taken.
  await page.goto("/goals/new");
  await pickKind(page, "Habit");
  await page.getByRole("button", { name: "Change days" }).click();
  const days = page.getByRole("dialog", { name: "How many days?" });
  await days.getByLabel("Or any number of days").fill("400");
  await days.getByRole("button", { name: "Use this" }).click();
  await expect(days.getByRole("alert")).toHaveText("Pick a whole number of days from 1 to 365.");
  await days.getByLabel("Or any number of days").fill("10");
  await days.getByRole("button", { name: "Use this" }).click();
  await expect(days).toBeHidden();
  await expect(page.getByRole("region", { name: "Pace" })).toContainText("10 check-ins, one a day");
  await page.getByRole("button", { name: "Create goal" }).click();
  const progress = page.getByRole("region", { name: "Progress" });
  await expect(progress).toContainText("0 of 10 days");
  const habitPath = new URL(page.url()).pathname;

  // One check-in today; the second is not offered, and the button says why.
  await page.getByRole("button", { name: "Check in for today" }).click();
  await expect(progress).toContainText("1 of 10 days");
  await expect(progress.getByRole("img", { name: "10 percent" })).toBeVisible();
  const done = page.getByRole("button", { name: "Checked in today" });
  await expect(done).toBeDisabled();
  await expect(page.getByRole("region", { name: "Check in" })).toContainText(
    "One check-in per day.",
  );
  // Still so after a fresh load: it is the day's check-in, not the button's state.
  await page.reload();
  await expect(page.getByRole("button", { name: "Checked in today" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Progress" })).toContainText("1 of 10 days");

  // Pay off $2,000: the balance today is $1,500, a quarter paid.
  await page.goto("/goals/new");
  await pickKind(page, "Pay off");
  await expect(page.getByRole("button", { name: "Change amount" })).toHaveText("$2,000.00");
  await page.getByRole("button", { name: "Create goal" }).click();
  await page.getByLabel("Current balance").fill("1500");
  await page.getByRole("button", { name: "Update" }).click();
  await expect(progress.getByRole("img", { name: "25 percent" })).toBeVisible();

  // Spend less: creating without the usual spend asks for it first.
  await page.goto("/goals/new");
  await pickKind(page, "Spend less");
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page.getByRole("alert")).toHaveText("Tell us what you usually spend on this first.");
  const usual = page.getByRole("dialog", { name: /What do you usually spend on/ });
  await usual.getByLabel("Usual monthly spend").fill("380");
  await usual.getByRole("button", { name: "Use this" }).click();
  await expect(usual).toBeHidden();
  await expect(page.getByText("Against your usual $380.00 a month.")).toBeVisible();
  await page.getByRole("button", { name: "Create goal" }).click();
  await expect(page.getByRole("region", { name: "This month" })).toContainText(
    "Usual spend $380.00.",
  );

  // The fourth: a jar. Private has room for 4 jars and goals.
  await quickJar(page);
  await page.goto("/goals");
  await expect(page.getByText("Using 4 of 4 on your plan")).toBeVisible();
  await expect(page.getByRole("link", { name: "See plans" })).toBeVisible();

  // The fifth is refused with the plan's card; nothing is created.
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Create jar" }).click();
  const limit = page.getByRole("status", { name: "Plan limit" });
  await expect(limit).toContainText("Your plan has room for 4 jars and goals, and you have 4.");
  await expect(limit.getByRole("link", { name: "See plans" })).toBeVisible();
  await expect(page).toHaveURL(/\/goals\/new$/);

  // Removing one frees its place; then the fifth goes through.
  await page.goto(habitPath);
  await page.getByRole("button", { name: "Remove goal" }).click();
  await page.getByRole("button", { name: "Really remove this goal" }).click();
  await expect(page.getByText("Using 3 of 4 on your plan")).toBeVisible();
  await quickJar(page, "Holiday");
  await expect(page.getByRole("heading", { level: 1, name: "Holiday" })).toBeVisible();
});

test("a challenge between two people: a wrong code, owner-only actions, percentages only on the board and in every request", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const ownerBodies = groupBodies(page);
  await readyAccount(page, "goals-owner");

  // A private jar with a name and an amount of my own: neither may reach the groups API.
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Change what it's for" }).click();
  const what = page.getByRole("dialog", { name: "What's it for?" });
  await what.getByLabel("Or name your own").fill("Kayak");
  await what.getByRole("button", { name: "Use this" }).click();
  await page.getByRole("button", { name: "Change amount" }).click();
  const amount = page.getByRole("dialog", { name: "How much?" });
  await amount.getByLabel("Or any amount").fill("4,321");
  await amount.getByRole("button", { name: "Use this" }).click();
  await page.getByRole("button", { name: "Create jar" }).click();
  await page.getByLabel("Other amount").fill("777");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByRole("region", { name: "Progress" })).toContainText("$777.00");

  // Start the monthly savings challenge: a target that isn't an amount is said first.
  await page.goto("/goals");
  await showChallenges(page);
  await page.getByRole("link", { name: "Start a challenge" }).click();
  await expect(page.getByRole("radio", { name: "Monthly savings" })).toBeChecked();
  await page.getByLabel("Or any amount").fill("plenty");
  await page.getByLabel("Your name, as members will see it").fill("Nia");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a target like 300.");
  await page.getByLabel("Or any amount").fill("400");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /savings challenge/ })).toBeVisible();
  const gid = new URL(page.url()).pathname.split("/").at(-1) as string;

  // The invite code; the owner may issue a new one.
  await page.getByRole("button", { name: "Invite" }).click();
  const invite = page.getByRole("dialog", { name: "Invite friends" });
  await expect(invite.getByRole("button", { name: "New invite code" })).toBeVisible();
  const code = ((await page.locator(".invite-code").textContent()) ?? "").replace(
    "Invite code: ",
    "",
  );
  expect(code).toMatch(/^STK-[A-Z0-9]{4}$/);
  await page.keyboard.press("Escape");

  // The owner keeps the group: no Leave button, and the server refuses it too.
  await expect(page.getByRole("button", { name: /Leave group/ })).toHaveCount(0);
  expect(await call(page, "POST", `/api/groups/${gid}/leave`)).toEqual({
    status: 409,
    code: "owner_cannot_leave",
  });

  // A second person, on their own device.
  const memberCtx = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const member = await memberCtx.newPage();
  const memberBodies = groupBodies(member);
  await readyAccount(member, "goals-member");
  // Not a member yet: the group is a 404, like any row that isn't theirs.
  expect(await call(member, "GET", `/api/groups/${gid}`)).toMatchObject({ status: 404 });

  // A code that points at nothing is said; the real one shows the group.
  await member.goto("/groups/join");
  const codeBox = member.getByLabel("Invite code");
  await codeBox.fill("STK-0000");
  await expect(member.getByRole("alert")).toHaveText(
    "No group with that code. Check it and try again.",
  );
  await codeBox.fill(code.toLowerCase());
  const preview = member.getByRole("region", { name: "Group", exact: true });
  await expect(preview).toContainText("Started by Nia");
  await expect(member.getByRole("radio", { name: "$250.00" })).toBeChecked();
  await member.getByLabel("Your name, as members will see it").fill("Dev");
  await member.getByRole("button", { name: 'Join as "Dev"' }).click();
  await expect(member.getByRole("heading", { level: 1, name: /savings challenge/ })).toBeVisible();
  // Nobody has logged anything: both wait off the board.
  await expect(
    member.getByText("Nobody has logged a deposit yet.", { exact: false }),
  ).toBeVisible();

  // Owner-only, asked by a member: the invite sheet has no New code, and the server says 403.
  await member.getByRole("button", { name: "Invite" }).click();
  const memberInvite = member.getByRole("dialog", { name: "Invite friends" });
  await expect(memberInvite.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(memberInvite.getByRole("button", { name: "New invite code" })).toHaveCount(0);
  await member.keyboard.press("Escape");
  const detail = await getJson<{ members: { user_id: string; is_owner: boolean }[] }>(
    member,
    `/api/groups/${gid}`,
  );
  const ownerId = detail.members.find((m) => m.is_owner)?.user_id as string;
  expect(await call(member, "POST", `/api/groups/${gid}/code`)).toEqual({
    status: 403,
    code: "owner_only",
  });
  expect(await call(member, "DELETE", `/api/groups/${gid}/members/${ownerId}`)).toEqual({
    status: 403,
    code: "owner_only",
  });
  // No Remove buttons on a member's board either.
  await expect(member.getByRole("button", { name: "Remove" })).toHaveCount(0);

  // Deposits: Dev logs half of $250, Nia a quarter of $400.
  await member.getByRole("link", { name: "Log a deposit" }).click();
  await member.getByLabel("Other amount").fill("125");
  await member.getByRole("button", { name: "Log", exact: true }).click();
  await expect(
    member.getByRole("region", { name: "Progress" }).getByRole("img", { name: "50 percent" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Log a deposit" }).click();
  await page.getByLabel("Other amount").fill("100");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Progress" }).getByRole("img", { name: "25 percent" }),
  ).toBeVisible();

  // The board on both devices: names and percents, ranked, never a dollar.
  await page.goto(`/groups/${gid}`);
  const board = page.getByRole("list", { name: "Leaderboard" });
  await expect(board.getByRole("listitem")).toHaveCount(2, { timeout: 20_000 });
  await expect(board.getByRole("listitem").nth(0)).toContainText("Dev");
  await expect(board.getByRole("listitem").nth(0)).toContainText("50%");
  await expect(board.getByRole("listitem").nth(1)).toContainText("You");
  await expect(board.getByRole("listitem").nth(1)).toContainText("25%");
  expect(await board.innerText()).not.toContain("$");
  await member.goto(`/groups/${gid}`);
  const memberBoard = member.getByRole("list", { name: "Leaderboard" });
  await expect(memberBoard.getByRole("listitem")).toHaveCount(2, { timeout: 20_000 });
  await expect(memberBoard.getByRole("listitem").nth(0)).toContainText("You");
  await expect(memberBoard.getByRole("listitem").nth(1)).toContainText("Nia");
  await expect(memberBoard.getByRole("listitem").nth(1)).toContainText("25%");
  expect(await memberBoard.innerText()).not.toContain("$");
  // What the server holds about each member: a percent, no amount anywhere.
  const held = JSON.stringify(await getJson(member, `/api/groups/${gid}`));
  for (const leak of ["_cents", "amount", "Kayak"]) expect(held).not.toContain(leak);

  // The owner removes Dev; Dev's code no longer lets them back in.
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Really remove Dev" }).click();
  await expect(board.getByRole("listitem")).toHaveCount(1);
  await member.goto(`/groups/join?code=${code}`);
  await expect(member.getByRole("alert")).toHaveText(
    "The owner removed you from this challenge, so you can't rejoin it.",
  );
  expect(await call(member, "GET", `/api/groups/${gid}`)).toMatchObject({ status: 404 });

  // A new code: the old one stops working.
  await page.getByRole("button", { name: "Invite" }).click();
  await invite.getByRole("button", { name: "New invite code" }).click();
  await expect(invite.getByRole("status")).toHaveText(
    "New code issued; the old one no longer works.",
  );
  expect(await call(page, "POST", "/api/groups/lookup", { code })).toMatchObject({ status: 404 });

  // Every body either device sent to the groups API: the code, the name, the type, a percent.
  // Never a target, a deposit, the private jar's name or amount.
  const sent = [...ownerBodies, ...memberBodies].join("\n");
  expect(sent).toContain("progress_bps");
  for (const leak of ["Kayak", "4321", "43.21", "777", "400", "125", "_cents", "amount"])
    expect(sent).not.toContain(leak);
  await memberCtx.close();
});

test("a challenge that starts later takes no progress yet, dates outside the window are refused, and a running one holds a place", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await readyAccount(page, "goals-later");

  // A No-Eat-Out Week starting in five days.
  await page.goto("/groups/new");
  const week = page.getByRole("radio", { name: "No-Eat-Out Week" });
  await week.locator("xpath=ancestor::label").click();
  await expect(week).toBeChecked();
  const start = isoInDays(5);
  await page.getByLabel("Start date").fill(start);
  await page.getByLabel("Your name, as members will see it").fill("Ash");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "No-Eat-Out Week" })).toBeVisible();
  const gid = new URL(page.url()).pathname.split("/").at(-1) as string;
  await expect(page.getByText(`Starts ${dayLabel(start)}. Log from then.`)).toBeVisible();
  await expect(page.getByRole("link", { name: "Check in for today" })).toHaveCount(0);

  // The server takes no percentage before the first day, whatever a device sends.
  expect(await call(page, "PUT", `/api/groups/${gid}/progress`, { progress_bps: 5000 })).toEqual({
    status: 409,
    code: "not_started",
  });
  // A start more than a month out, or a month far away, is refused.
  expect(
    await call(page, "POST", "/api/groups", {
      name: "Too far",
      template_key: "no_eat_out_week",
      month: null,
      start_date: isoInDays(45),
    }),
  ).toEqual({ status: 422, code: "start_date_out_of_range" });
  expect(
    await call(page, "POST", "/api/groups", {
      name: "Too far",
      template_key: "monthly_savings",
      month: isoInDays(120).slice(0, 7),
      start_date: null,
    }),
  ).toEqual({ status: 422, code: "month_out_of_range" });

  // The challenge's own goal holds a place on the plan: three jars fill it.
  for (const name of ["One", "Two", "Three"]) await quickJar(page, name);
  await page.goto("/goals");
  await expect(page.getByText("Using 4 of 4 on your plan (1 is a challenge)")).toBeVisible();
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page.getByRole("status", { name: "Plan limit" })).toContainText(
    "Your plan has room for 4 jars and goals, and you have 4.",
  );
});

test("starting or joining a challenge with every place on the plan taken is refused before anything is made", async ({
  page,
  browser,
}) => {
  test.setTimeout(200_000);
  await readyAccount(page, "goals-fullchal");
  for (const name of ["One", "Two", "Three", "Four"]) await quickJar(page, name);
  await page.goto("/goals");
  await expect(page.getByText("Using 4 of 4 on your plan")).toBeVisible();

  // A challenge's jar takes a place like any other (invariant 90), so a fifth through a
  // challenge meets the same card as a fifth through the builder, and the server is never asked.
  const asked: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "POST" && (path === "/api/groups" || path === "/api/groups/join"))
      asked.push(path);
  });
  await page.goto("/groups/new");
  await page.getByLabel("Your name, as members will see it").fill("Kim");
  await page.getByRole("button", { name: "Start challenge" }).click();
  const limit = page.getByRole("status", { name: "Plan limit" });
  await expect(limit).toContainText("Your plan has room for 4 jars and goals, and you have 4.");
  await expect(limit.getByRole("link", { name: "See plans" })).toBeVisible();
  await expect(page).toHaveURL(/\/groups\/new$/);

  // Someone else's challenge, joined by its code: refused the same way.
  const otherCtx = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
  const other = await otherCtx.newPage();
  await readyAccount(other, "goals-fullchal-owner");
  await other.goto("/groups/new");
  await other.getByLabel("Your name, as members will see it").fill("Ana");
  await other.getByRole("button", { name: "Start challenge" }).click();
  await expect(other.getByRole("heading", { level: 1, name: /savings challenge/ })).toBeVisible();
  await other.getByRole("button", { name: "Invite" }).click();
  const code = ((await other.locator(".invite-code").textContent()) ?? "").replace(
    "Invite code: ",
    "",
  );
  await otherCtx.close();

  await page.goto(`/groups/join?code=${code}`);
  await expect(page.getByRole("region", { name: "Group", exact: true })).toContainText(
    "Started by Ana",
  );
  await page.getByLabel("Your name, as members will see it").fill("Kim");
  await page.getByRole("button", { name: 'Join as "Kim"' }).click();
  await expect(page.getByRole("status", { name: "Plan limit" })).toContainText(
    "A challenge takes one place too.",
  );
  await expect(page).toHaveURL(/\/groups\/join/);
  expect(asked).toHaveLength(0);

  await page.goto("/goals");
  await expect(page.getByText("Using 4 of 4 on your plan")).toBeVisible();
});
