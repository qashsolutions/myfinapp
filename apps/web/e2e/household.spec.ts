import { expect, type Page, test } from "@playwright/test";
import { inviteLink, joinFromInvite, readyAccount, setName } from "./helpers.ts";

/**
 * A household of two end to end (chunk 1.16; owner decisions October 29, 2026; invariants 54,
 * 55, 67–70): the invite link carries the key in its fragment, the partner signs up from it with
 * no trial of their own and is covered by one plan, a shared jar shows who added what on both
 * devices, month totals are seen together once both share, and leaving keeps each person's own
 * deposits while the one who was covered gets their own 7 days. The household key and the jar's name never reach the server in the clear.
 */

const JAR = "Canoe"; // a jar name nothing else in the app uses

function watch(page: Page, seen: string[]) {
  page.on("request", (r) => {
    if (r.url().includes("/api/")) seen.push(`${r.url()} ${r.postData() ?? ""}`);
  });
}

test("@phone household: invite by link, one plan covers both, a shared jar shows who added what, then leave", async ({
  page,
  browser,
}) => {
  const seen: string[] = [];
  watch(page, seen);
  await readyAccount(page, "home-a", "Connected");
  await setName(page, "Ana");

  // Ana makes the invite; the key travels in the link's fragment only.
  const link = await inviteLink(page);
  expect(link).toMatch(/\/household\/join\?code=HH-[A-Z0-9]{6}#k=/);
  const key = link.split("#k=")[1] as string;

  // Ben opens it signed out, signs up from it, and joins without picking a trial.
  const ben = await (await browser.newContext()).newPage();
  watch(ben, seen);
  await joinFromInvite(ben, link, "Ana");

  // One plan for two: Ben's is Ana's, with nothing to buy.
  await ben.goto("/me/plan");
  await expect(ben.getByText(/Covered by Ana's|Shared with Ana/).first()).toBeVisible();
  await setName(ben, "Ben");

  // Ana sees Ben, and shares a new jar with him.
  await page.goto("/me/household");
  await expect(page.getByText("Ben", { exact: true })).toBeVisible();
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Change what it's for" }).click();
  await page.getByLabel("Or name your own").fill(JAR);
  await page.getByRole("button", { name: "Use this" }).click();
  await page.getByText("Share with Ben", { exact: true }).click();
  await expect(page.getByRole("switch", { name: "Share with Ben" })).toBeChecked();
  await page.getByRole("button", { name: "Create jar" }).click();
  await page.getByLabel("Other amount").fill("100");
  await page.getByRole("button", { name: "Log" }).click();
  await expect(page.getByText(/· you/).first()).toBeVisible();

  // Ben finds it under Shared jars with Ana's part, and adds his own.
  await ben.goto("/me/household");
  const shared = ben.getByRole("article", { name: JAR });
  await expect(shared).toBeVisible({ timeout: 30_000 });
  await expect(shared.getByText(/Ana \$100/)).toBeVisible();
  await shared.getByRole("button", { name: "Open" }).click();
  await ben.getByLabel("Other amount").fill("40");
  await ben.getByRole("button", { name: "Log" }).click();
  await expect(ben.getByText("$140").first()).toBeVisible();

  // Ana's jar shows Ben's deposit by name.
  await expect(page.getByText(/· Ben/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("$140").first()).toBeVisible();

  // Month totals: shown together only once both share.
  for (const p of [page, ben]) {
    await p.goto("/me/household");
    await p.getByText("Share my month totals", { exact: true }).click();
    await expect(p.getByRole("switch", { name: "Share my month totals" })).toBeChecked();
  }
  await page.reload();
  await expect(page.getByText("Kept", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Ben leaves. The plan was Ana's, so it stops covering him: 7 days to pick his own or take
  // his data, with the app locked to that meanwhile (invariant 54).
  await ben.goto("/me/household");
  await ben.getByRole("button", { name: "Leave household" }).click();
  await ben
    .getByRole("dialog", { name: "Leave the household?" })
    .getByRole("button", { name: "Leave household" })
    .click();
  await expect(ben.getByText("Your household's plan no longer covers you")).toBeVisible();
  await expect(ben.getByRole("link", { name: "Download my data" })).toBeVisible();

  // Ana's copy of the jar keeps her own deposits only, and Ben is gone from the household.
  await page.goto("/me/household");
  await expect(page.getByText("Ben", { exact: true })).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Make an invite link" })).toBeVisible();
  await page.goto("/goals");
  await expect(page.getByText(JAR).first()).toBeVisible();
  await expect(page.getByText("$100").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("$140")).toBeHidden();

  // The key and the jar's name never reached the server.
  for (const r of seen) {
    expect(r).not.toContain(key);
    expect(r).not.toContain(JAR);
  }
});
