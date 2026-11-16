import { expect, test } from "@playwright/test";
import { samplePositionsPdf } from "../tests/fixtures/pdf.ts";
import { readyAccount } from "./helpers.ts";

/**
 * Documents with a total (November 16, 2026): an IRA positions PDF, read on the device, becomes
 * one checked account in Net worth with its date; nothing of it is sent.
 */
test("@phone an IRA positions page goes to Net worth with its total and date", async ({ page }) => {
  await readyAccount(page, "nw-docs");
  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.url()} ${r.postData() ?? ""}`));
  await page.goto("/import");
  await page.getByLabel(/Choose a statement file/).setInputFiles({
    name: "Positions.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(samplePositionsPdf()),
  });
  const card = page.getByRole("region", { name: "Found in this document" });
  await expect(card).toContainText("An account's total of $1,250.40 as of Sep 3, 2026.");
  await expect(card.getByLabel("Name")).toHaveValue("Rollover IRA");
  await expect(page.getByRole("button", { name: "Read file" })).toHaveCount(0);
  await card.getByRole("button", { name: "Add to Net worth" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Net worth" })).toBeVisible();
  await expect(page.getByText(/As of Sep 3, 2026 · from a document/)).toBeVisible();
  await expect(page.getByText("$1,250.40").first()).toBeVisible();
  expect(sent.join("\n")).not.toMatch(/1250|125040|Rollover|123456789/);
});
