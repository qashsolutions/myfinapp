import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { readyAccount } from "./helpers.ts";

/**
 * Receipt photos end to end (chunk 1.9 and fast-follow 6): a photo attached while adding an
 * entry, its location data stripped before it is kept, the text read on this device and used
 * only after "Use these", a photo on an entry never saved leaving with the screen, the photos in
 * the export without their metadata, and Delete all receipt photos keeping the entries. Nothing about a receipt is ever sent to the server.
 */

const MARKER = "QashGPS-48.8584N-2.2945E"; // stands in for the location a camera writes

/** A real JPEG drawn by the browser, with an EXIF segment carrying MARKER put in after SOI. */
async function jpegWithLocation(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async (marker) => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 40;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#e8d9b0";
    ctx.fillRect(0, 0, 40, 40);
    const blob = await new Promise<Blob>((r) =>
      canvas.toBlob((b) => r(b as Blob), "image/jpeg", 0.9),
    );
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const payload = new TextEncoder().encode(`Exif\0\0${marker}`);
    const len = payload.length + 2;
    const app1 = new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
    return [...jpeg.slice(0, 2), ...app1, ...jpeg.slice(2)];
  }, MARKER);
  return Buffer.from(bytes);
}

test("@phone receipts: a photo's location stripped, its text read on the device, exported clean, then all deleted", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) sent.push(`${r.url()} ${r.postData() ?? ""}`);
  });
  await readyAccount(page, "receipts");

  // A receipt read on the device: nothing fills the form until "Use these".
  await page.goto("/add?with=receipt");
  await page.getByLabel("Add a receipt photo").setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: readFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "receipt.png")),
  });
  await expect(page.getByText("Receipt photo attached")).toBeVisible();
  await page.getByRole("button", { name: "Read text from photo" }).click();
  await expect(page.getByText("From the photo, to check:")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Merchant: Corner Market")).toBeVisible();
  await expect(page.getByText("Total: $11.91")).toBeVisible();
  await expect(page.getByLabel("Amount")).toHaveValue("");
  await page.getByRole("button", { name: "Use these" }).click();
  await expect(page.getByLabel("Amount")).toHaveValue("11.91");
  await expect(page.getByLabel("Merchant")).toHaveValue("Corner Market");
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions/);

  // A camera photo with its location: kept only without it.
  await page.goto("/add?with=receipt");
  await page.getByLabel("Add a receipt photo").setInputFiles({
    name: "IMG_0412.jpg",
    mimeType: "image/jpeg",
    buffer: await jpegWithLocation(page),
  });
  await expect(page.getByText("Receipt photo attached")).toBeVisible();
  await page.getByLabel("Amount").fill("8.40");
  await page.getByLabel("Merchant").fill("Lantern Bakery");
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page).toHaveURL(/\/money\?view=transactions/);

  // A photo attached and the screen left without saving: it goes with the screen.
  await page.goto("/add?with=receipt");
  await page.getByLabel("Add a receipt photo").setInputFiles({
    name: "IMG_0413.jpg",
    mimeType: "image/jpeg",
    buffer: await jpegWithLocation(page),
  });
  await expect(page.getByText("Receipt photo attached")).toBeVisible();
  await page.getByRole("link", { name: "Home" }).click();

  // The export carries the two saved photos only, with no location (a stored ZIP: the bytes
  // are as kept). Reached inside the app, as a person would, not by reloading.
  await page.getByRole("link", { name: "Me", exact: true }).click();
  await page.getByRole("link", { name: "Money & data" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all my data" }).click();
  const zip = readFileSync(await (await download).path());
  // Each name is in the ZIP twice: its local header and the central directory.
  const names = new Set(zip.toString("latin1").match(/receipts\/[0-9a-f-]+\.(png|jpg)/g));
  expect(names.size).toBe(2);
  expect(zip.includes(Buffer.from(MARKER))).toBe(false);

  // Delete all receipt photos: asked first with the real count, the entries stay.
  await page.goto("/me/data");
  await page.getByRole("button", { name: "Delete all receipt photos" }).click();
  const sheet = page.getByRole("dialog", { name: "Delete all receipt photos?" });
  await expect(sheet.getByText("This removes 2 photos from this device, for good.")).toBeVisible();
  await sheet.getByRole("button", { name: "Delete 2 photos" }).click();
  await expect(page.getByText("2 photos deleted from this device.")).toBeVisible();
  await expect(page.getByRole("button", { name: "No photos to delete" })).toBeDisabled();
  // A second export: both entries, no photos.
  const again = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all my data" }).click();
  const after = readFileSync(await (await again).path()).toString("latin1");
  expect(after).toContain("Corner Market"); // dated the receipt's own day, read off it
  expect(after).toContain("Lantern Bakery");
  expect(after).not.toMatch(/receipts\/[0-9a-f-]+\.(png|jpg)/);

  // Nothing about a receipt reached the server.
  for (const r of sent) {
    expect(r).not.toContain("Corner Market");
    expect(r).not.toContain("Lantern Bakery");
    expect(r).not.toContain(MARKER);
  }
});
