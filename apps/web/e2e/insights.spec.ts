import { expect, type Page, test } from "@playwright/test";
import { isoInDays, readyAccount } from "./helpers.ts";

/**
 * Insight screens end to end: a rename that covers every entry like it and future statements
 * (merchant names), a tag and a note seen across categories on the tag's screen, Biggest & most
 * often, and net worth with things owned and owed by hand, one updated. Everything here is
 * on the device: no request carries a merchant, a tag, a note or an item's name.
 */

function csv(rows: string[]) {
  const buffer = Buffer.from(["Posting Date,Description,Amount", ...rows, ""].join("\n"));
  return { name: "statement.csv", mimeType: "text/csv", buffer };
}

async function importCsv(page: Page, file: ReturnType<typeof csv>, fresh: number, first: boolean) {
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(file);
  if (first) {
    await page.getByRole("button", { name: "+ New account" }).click();
    await page.getByLabel("Account name").fill("Everyday checking");
    await page.getByRole("button", { name: "Add account" }).click();
  } else {
    await page
      .getByRole("radio", { name: /Everyday checking/ })
      .locator("xpath=ancestor::label")
      .click();
  }
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page
    .getByRole("button", {
      name: `Import ${fresh} ${fresh === 1 ? "transaction" : "transactions"}`,
    })
    .click();
  await expect(page).toHaveURL(/\/money\?view=transactions/);
}

test("@phone insights: rename all like it, a tag and a note, biggest & most often, net worth by hand", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) sent.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  await readyAccount(page, "insights");
  const today = isoInDays(0);
  await importCsv(
    page,
    csv([
      `${today},CORNER MKT #214,-42.17`,
      `${today},METRO TRANSIT 4471,-2.75`,
      `${today},METRO TRANSIT 4471,-3.10`,
      `${today},SKYLINE FURNITURE,-899.00`,
      `${today},ACME PAYROLL,2400.00`,
    ]),
    5,
    true,
  );

  // Rename one METRO TRANSIT: both like it change, and the name is kept for the next statement.
  await page
    .getByText(/METRO TRANSIT/)
    .first()
    .click();
  await page.getByLabel("Merchant").fill("Subway pass");
  await expect(page.getByRole("switch", { name: "Rename all 2 like this" })).toBeChecked();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions/);
  await expect(page.getByText("Subway pass")).toHaveCount(2);
  await importCsv(page, csv([`${today},METRO TRANSIT 4471,-2.90`]), 1, false);
  await expect(page.getByText("Subway pass")).toHaveCount(3);

  // A tag and a note on the shop's entry; the tag's screen adds it up.
  await page
    .getByText(/CORNER MKT/)
    .first()
    .click();
  const tag = page.getByPlaceholder("Add a tag, like Hawaii trip");
  await tag.fill("Picnic");
  await tag.press("Enter");
  await page.getByLabel("Note").fill("Bread and cheese for Saturday");
  await page.getByRole("button", { name: /^Save/ }).click();
  // Saved once it's back on the list: the tag chip in the editor matches too, and a reload
  // before the save lands would cut it off.
  await expect(page).toHaveURL(/\/money\?view=transactions/);
  await expect(page.getByText(/#Picnic/).first()).toBeVisible();
  await expect(page.getByText(/Bread and cheese for Saturday/).first()).toBeVisible();
  await page.goto("/tags");
  await page.getByText("#Picnic").click();
  await expect(page.getByRole("heading", { level: 1, name: "#Picnic" })).toBeVisible();
  await expect(page.getByRole("region", { name: "#Picnic in all" })).toContainText("$42.17");
  await expect(page.getByRole("list", { name: "Entries tagged Picnic" })).toContainText(
    "CORNER MKT",
  );

  // Biggest single amounts and who's paid most often.
  await page.goto("/insights/spending");
  await expect(page.getByRole("heading", { level: 1, name: "Biggest & most often" })).toBeVisible();
  const biggest = page.getByRole("region", { name: "Biggest single amounts" });
  await expect(biggest.getByRole("link").first()).toContainText("SKYLINE FURNITURE");
  const often = page.getByRole("region", { name: "Paid most often" });
  await expect(often.locator(".often__row").first()).toContainText("3 times");

  // Net worth: something owned and something owed, by hand.
  await page.goto("/net-worth");
  await page.getByRole("button", { name: "+ Something you own" }).click();
  let sheet = page.getByRole("dialog", { name: "Something you own" });
  await sheet.getByLabel("Name").fill("Brokerage");
  await sheet.getByLabel("What it's worth").fill("5000");
  await sheet.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "+ Something you owe" }).click();
  sheet = page.getByRole("dialog", { name: "Something you owe" });
  await sheet.getByLabel("Name").fill("Car loan");
  await sheet.getByLabel("Amount owed").fill("3000");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: /What you owe \$3,000\.00/ })).toBeVisible();
  await expect(page.getByText("Brokerage")).toBeVisible();
  // Paid some off: tap it and update the amount.
  await page.getByText("Car loan").click();
  sheet = page.getByRole("dialog", { name: "Update" });
  await sheet.getByLabel("Amount owed").fill("2500");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: /What you owe \$2,500\.00/ })).toBeVisible();

  // None of it left the device.
  for (const r of sent)
    for (const word of ["Subway pass", "Picnic", "Bread and cheese", "Brokerage", "Car loan"])
      expect(r).not.toContain(word);
});
