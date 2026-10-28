import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isoInDays, readyAccount, statementThisMonth } from "../e2e/helpers.ts";

/**
 * Every screen, phone and computer, light and dark (October 28, 2026): screenshots plus the same
 * measures for each (sideways scroll, text sizes, off-palette colours, small or non-kit buttons,
 * the one word, how much text). `pnpm -C apps/web audit:screens`; output in e2e-audit/.output.
 */
const OUT = process.env.AUDIT_OUT ?? join(import.meta.dirname, ".output");

/** What every screen is measured on: one shape, so screens compare. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    // The palette: every --c-* token resolved to rgb.
    const probe = document.createElement("span");
    document.body.append(probe);
    const tokens = new Set<string>();
    const rootStyle = getComputedStyle(doc);
    for (let i = 0; i < rootStyle.length; i++) {
      const name = rootStyle[i] as string;
      if (!name.startsWith("--c-")) continue;
      probe.style.color = rootStyle.getPropertyValue(name).trim();
      tokens.add(getComputedStyle(probe).color);
    }
    probe.remove();
    tokens.add("rgb(255, 255, 255)"); // on-accent / danger text
    const offPalette = new Map<string, string>();
    const sizes = new Map<string, number>();
    const smallTargets: string[] = [];
    const notKitButtons: string[] = [];
    const main = document.querySelector("main") ?? document.body;
    for (const el of main.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 1,
      );
      if (hasText) {
        sizes.set(s.fontSize, (sizes.get(s.fontSize) ?? 0) + 1);
        if (!tokens.has(s.color) && !s.color.startsWith("rgba"))
          offPalette.set(
            `text ${s.color}`,
            el.tagName.toLowerCase() + "." + [...el.classList].join("."),
          );
      }
      const bg = s.backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && !bg.startsWith("rgba") && !tokens.has(bg))
        offPalette.set(`fill ${bg}`, el.tagName.toLowerCase() + "." + [...el.classList].join("."));
      const isControl =
        el.matches(
          "button, [role=button], a.sk-btn, input[type=submit], select, label.chip-option",
        ) && !el.closest("nav");
      if (isControl) {
        const r = el.getBoundingClientRect();
        const name =
          (el.textContent ?? "").trim().slice(0, 28) || el.getAttribute("aria-label") || "?";
        if (r.height < 44 && !el.matches(".auth__link"))
          smallTargets.push(`${name} ${Math.round(r.height)}px`);
        if (
          el.matches("button, a.sk-btn") &&
          !el.matches(".sk-btn, .auth__link") &&
          !el.closest(".sk-row, .swipe")
        )
          notKitButtons.push(`${name} .${[...el.classList].join(".")}`);
      }
    }
    const text = (main as HTMLElement).innerText ?? "";
    const paragraphs = [...main.querySelectorAll("p")]
      .filter(visible)
      .map((p) => (p.textContent ?? "").trim().split(/\s+/).filter(Boolean).length);
    const longText = [...main.querySelectorAll("p, li, label span, .auth__hint")]
      .filter(visible)
      .map((p) => (p.textContent ?? "").trim())
      .filter((t) => t.split(/\s+/).length > 20);
    return {
      longText: [...new Set(longText)],
      overflowPx: doc.scrollWidth - doc.clientWidth,
      title: document.title,
      hasWord: Boolean(main.querySelector(".word, .insight-card__headline")),
      h1: [...main.querySelectorAll("h1")].map((h) => h.textContent?.trim()),
      words: text.split(/\s+/).filter(Boolean).length,
      longestParagraph: Math.max(0, ...paragraphs),
      fontSizes: Object.fromEntries([...sizes.entries()].sort((a, b) => b[1] - a[1])),
      offPalette: [...offPalette.entries()].slice(0, 12),
      smallTargets: smallTargets.slice(0, 12),
      notKitButtons: [...new Set(notKitButtons)].slice(0, 12),
    };
  });
}

test("every screen", async ({ page }, info) => {
  test.setTimeout(15 * 60_000);
  const device = info.project.name;
  mkdirSync(`${OUT}/${device}`, { recursive: true });

  await readyAccount(page, `audit${device}`);
  // Realistic data: a statement, pay and a budget, a jar with a deposit, a bill, a challenge.
  console.log("seed step 0");
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(statementThisMonth());
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByText("ACME PAYROLL")).toBeVisible();
  const entryId = await page
    .getByRole("button", { name: /CORNER MKT/ })
    .click()
    .then(async () => {
      await page.waitForURL(/\/entries\//, { timeout: 15_000 });
      return page.url().split("/entries/")[1] ?? "";
    });

  console.log("seed step 1");
  await page.goto("/budget");
  await page
    .getByLabel(/paycheck/i)
    .first()
    .fill("2600");
  await page.getByRole("radio", { name: "Twice a month" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Needs · 50%/)).toBeVisible();

  console.log("seed step 2");
  await page.goto("/goals/new");
  await page.getByRole("button", { name: "Create jar" }).click();
  await expect(page.getByRole("img", { name: "0 percent" })).toBeVisible();
  const goalUrl = new URL(page.url()).pathname;
  await page.getByLabel("Other amount").fill("100");
  await page
    .getByRole("button", { name: /^Add|Deposit|Log/ })
    .first()
    .click()
    .catch(() => {});

  console.log("seed step 3");
  await page.goto("/bills");
  await page.getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add a bill or income" });
  await sheet.getByLabel("Name").fill("Phone");
  await sheet.getByLabel("Amount").fill("45");
  await sheet.getByLabel("Next date").fill(isoInDays(5));
  await sheet.getByRole("button", { name: "Add" }).click();

  console.log("seed step 4");
  await page.goto("/groups/new");
  const name = page.getByLabel("Your name, as members will see it");
  if (await name.isVisible().catch(() => false)) await name.fill("Nia");
  await page.getByRole("button", { name: "Start challenge" }).click();
  await page.waitForURL(/\/groups\/[^n]/, { timeout: 15_000 }).catch(() => {});
  const groupUrl = new URL(page.url()).pathname;

  console.log("seed step 5");
  const routes = [
    "/",
    "/money",
    "/money?view=transactions",
    "/budget",
    "/goals",
    goalUrl,
    "/goals/new",
    "/groups/new",
    groupUrl,
    "/insights",
    "/insights/spending",
    "/insights/later",
    "/subscriptions",
    "/review",
    "/net-worth",
    "/setup",
    "/tags",
    "/forecast",
    "/bills",
    "/emergency",
    "/recap",
    "/import",
    "/add",
    `/entries/${entryId}`,
    "/me",
    "/me/account",
    "/me/data",
    "/me/groups",
    "/me/look",
    "/me/help",
    "/me/security",
    "/me/accounts",
    "/me/categories",
    "/me/email",
    "/me/delete",
    "/me/notifications",
    "/me/plan",
    "/me/household",
    "/me/linking",
    "/install",
    "/nope",
  ];
  for (const scheme of ["light", "dark"] as const) {
    if (scheme === "dark" && device !== "phone") continue;
    await page.emulateMedia({ colorScheme: scheme });
    for (const route of routes) {
      console.log(`${scheme} ${route}`);
      await page.goto(route);
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(600); // live queries and the engine settle
      const key = route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home";
      await page.screenshot({
        path: `${OUT}/${device}/${scheme}-${key}.jpg`,
        fullPage: true,
        type: "jpeg",
        quality: 55,
      });
      if (scheme === "light") {
        const m = await measure(page);
        appendFileSync(`${OUT}/measure.jsonl`, `${JSON.stringify({ device, route, key, ...m })}\n`);
      }
    }
  }
});
