import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { sampleStatementPdf } from "../tests/fixtures/pdf.ts";
import { readyAccount } from "./helpers.ts";

/**
 * PDF and OFX statements end to end (chunk 1.3b and fast-follow 2): a PDF read on the device
 * offers its own account in one tap, says the rows add up to the ending balance and opens on the
 * statement's month; a QFX for
 * the same account (same last four) goes into it; the same QFX again finds nothing new. No
 * statement row ever reaches the server.
 */

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");

test("@phone statements: a PDF that reconciles, a QFX into the same account, and a re-upload that skips every row", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) sent.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  await readyAccount(page, "imports");

  // A PDF: the bank, account type and last four come from the statement itself.
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles({
    name: "statement-sep.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(sampleStatementPdf()),
  });
  await page.getByRole("button", { name: /^\+ New account: .*4821/ }).click();
  await page.getByRole("button", { name: "Read file" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
  await expect(
    page.getByText("Read from a PDF. The rows add up to your statement's ending balance."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import 4 transactions" }).click();
  // It opens on the statement's newest month, not an empty one.
  await expect(page.getByText("October 2026")).toBeVisible();
  await expect(page.getByText(/CHECK 1041/).first()).toBeVisible();
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(page.getByText(/ACME PAYROLL/).first()).toBeVisible();

  // A QFX from the same account: its last four picks the account by itself.
  const qfx = {
    name: "checking.qfx",
    mimeType: "application/x-qfx",
    buffer: readFileSync(join(FIXTURES, "checking.qfx")),
  };
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(qfx);
  await expect(page.getByRole("radio", { name: /4821/ })).toBeChecked();
  await page.getByRole("button", { name: "Read file" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review import" })).toBeVisible();
  await page.getByRole("button", { name: "Import 2 transactions" }).click();
  await expect(page.getByText("October 2026")).toBeVisible();
  await expect(page.getByText(/CORNER MKT/).first()).toBeVisible();

  // The same file again: every row is already in Qash, so there is nothing to import.
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles(qfx);
  await page.getByRole("button", { name: "Read file" }).click();
  const skipped = page.locator(".stat", { hasText: "already in Qash · skipped" });
  await expect(skipped).toContainText("2");
  await expect(page.locator(".stat", { hasText: "new" }).first()).toContainText("0");
  await expect(page.getByRole("button", { name: "Nothing new to import" })).toBeDisabled();

  // Statement rows stay on the device.
  for (const r of sent) {
    expect(r).not.toContain("ACME PAYROLL");
    expect(r).not.toContain("CORNER MKT");
  }
});
