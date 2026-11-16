import { expect, test } from "@playwright/test";
import { samplePositionsPdf } from "../tests/fixtures/pdf.ts";
import { readyAccount, statementThisMonth } from "./helpers.ts";

/**
 * Several files at once (owner decisions, November 16, 2026): a positions PDF and a statement
 * CSV picked together, read on the device one after another; Do all adds the document, Check
 * imports the statement; Your documents lists both with masked names. Nothing is sent.
 */
test("@phone two files at once: Do all, Check, then Your documents", async ({ page }) => {
  await readyAccount(page, "batch");
  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));
  await page.goto("/import");
  await expect(page.getByText(/Up to 5 files at a time, 2 MB each, 10 MB in all/)).toBeVisible();
  await page.getByLabel(/Choose a statement file/).setInputFiles([
    {
      name: "Positions_250044484.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(samplePositionsPdf()),
    },
    statementThisMonth(),
  ]);
  const list = page.getByRole("list", { name: "Files picked" });
  await expect(page.getByRole("region", { name: "Your files" })).toContainText("Ready");
  await expect(list.getByRole("listitem").nth(0)).toContainText("Positions_••4484.pdf");
  await expect(list.getByRole("listitem").nth(0)).toContainText("Found · Rollover IRA");
  await expect(list.getByRole("listitem").nth(1)).toContainText("check to pick the account");

  await page.getByRole("button", { name: "Do all 1" }).click();
  await expect(list.getByRole("listitem").nth(0)).toContainText("→ Net worth");

  await list.getByRole("listitem").nth(1).getByRole("button", { name: "Check" }).click();
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByLabel("Account name").fill("Everyday checking");
  await page.getByRole("button", { name: "Add account" }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await page.getByRole("button", { name: "Looks right" }).click();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  await expect(page.getByRole("region", { name: "Your files" })).toContainText("Done");

  await page.goto("/me/documents");
  const docs = page.getByRole("list", { name: "Files added" });
  await expect(docs.getByRole("listitem")).toHaveCount(2);
  await expect(docs).toContainText("Positions_••4484.pdf");
  await expect(docs).toContainText("statement.csv");
  expect(sent.join("\n")).not.toMatch(/250044484|CORNER MKT|ACME PAYROLL|Rollover/);
});
